/**
 * Crawler Durable Object — one instance per source ("sec", "asx", "rns", "adyen").
 *
 * Holds a SQLite job queue and a "seen" table of archived filings. Jobs are
 * processed by the alarm handler in small batches so that a multi-thousand
 * document backfill is spread over many invocations, each well inside the
 * Workers subrequest/CPU limits, while all upstream requests for one source
 * are serialised through a single throttled fetcher (per-source rate limit).
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env, FilingRef, Holding, Job, ListMode, SourceContext, SourceId, StoredObject } from './types';
import { SOURCES } from './sources';
import { sleep } from './util';

const BATCH_JOBS = 60; // jobs per alarm invocation
const BATCH_WALL_MS = 45_000; // stop picking new jobs after this much wall time
const MAX_ATTEMPTS = 6;
const MAX_OBJECT_BYTES = 200 * 1024 * 1024;

interface JobRow extends Record<string, SqlStorageValue> {
  id: number;
  kind: string;
  ticker: string;
  dedupe: string;
  payload: string;
  attempts: number;
  not_before: number;
  created: number;
}

export interface SourceStatus {
  source: string;
  pendingJobs: number;
  pendingByKind: Record<string, number>;
  pendingByTicker: Record<string, number>;
  failedJobs: number;
  seen: number;
  seenByTicker: Record<string, number>;
  alarmAt: number | null;
  lastRun: Record<string, string>;
  lastError?: string;
  lastBatch?: { at: string; jobs: number; ms: number } | null;
}

export class Crawler extends DurableObject<Env> {
  private sql: SqlStorage;
  /** Earliest time the next upstream request may start (slot-based throttle, safe under concurrency). */
  private nextSlotAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        ticker TEXT NOT NULL,
        dedupe TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        not_before INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(not_before, id);
      CREATE TABLE IF NOT EXISTS failed (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        ticker TEXT NOT NULL,
        payload TEXT NOT NULL,
        error TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        failed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seen (
        ticker TEXT NOT NULL,
        fid TEXT NOT NULL,
        date TEXT NOT NULL,
        time TEXT,
        title TEXT NOT NULL,
        form TEXT,
        keys TEXT NOT NULL,
        archived_at INTEGER NOT NULL,
        PRIMARY KEY (ticker, fid)
      );
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  private get sourceId(): SourceId {
    const name = this.ctx.id.name;
    if (!name || !(name in SOURCES)) throw new Error(`Crawler DO must be addressed by source name, got ${name}`);
    return name as SourceId;
  }

  private kvGet(k: string): string | undefined {
    const row = this.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', k).toArray()[0];
    return row?.v;
  }

  private kvSet(k: string, v: string): void {
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }

  private enqueue(job: Job, dedupe: string, ticker: string): boolean {
    const r = this.sql.exec(
      'INSERT OR IGNORE INTO jobs (kind, ticker, dedupe, payload, created) VALUES (?, ?, ?, ?, ?)',
      job.kind,
      ticker,
      dedupe,
      JSON.stringify(job),
      Date.now(),
    );
    return r.rowsWritten > 0;
  }

  private async ensureAlarm(delayMs = 0): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    const want = Date.now() + delayMs;
    if (current === null || current > want) await this.ctx.storage.setAlarm(want);
  }

  // ---------- RPC methods (called from the Worker) ----------

  /** Queue a listing run for a holding. Returns true when a new list job was queued. */
  async enqueueSync(holding: Holding, mode: ListMode): Promise<boolean> {
    if (!holding.sources.includes(this.sourceId)) throw new Error(`${holding.ticker} is not configured for source ${this.sourceId}`);
    const dedupe = `list:${holding.ticker}:${mode}:start`;
    const queued = this.enqueue({ kind: 'list', ticker: holding.ticker, mode, holding } as Job, dedupe, holding.ticker);
    this.kvSet(`holding:${holding.ticker}`, JSON.stringify(holding));
    await this.ensureAlarm();
    return queued;
  }

  async status(): Promise<SourceStatus> {
    const byKind: Record<string, number> = {};
    for (const r of this.sql.exec<{ kind: string; n: number }>('SELECT kind, COUNT(*) AS n FROM jobs GROUP BY kind')) byKind[r.kind] = r.n;
    const byTicker: Record<string, number> = {};
    for (const r of this.sql.exec<{ ticker: string; n: number }>('SELECT ticker, COUNT(*) AS n FROM jobs GROUP BY ticker')) byTicker[r.ticker] = r.n;
    const seenByTicker: Record<string, number> = {};
    for (const r of this.sql.exec<{ ticker: string; n: number }>('SELECT ticker, COUNT(*) AS n FROM seen GROUP BY ticker')) seenByTicker[r.ticker] = r.n;
    const lastRun: Record<string, string> = {};
    for (const r of this.sql.exec<{ k: string; v: string }>("SELECT k, v FROM kv WHERE k LIKE 'lastrun:%'")) lastRun[r.k.slice(8)] = r.v;
    return {
      source: this.sourceId,
      pendingJobs: Object.values(byKind).reduce((a, b) => a + b, 0),
      pendingByKind: byKind,
      pendingByTicker: byTicker,
      failedJobs: this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM failed').one().n,
      seen: Object.values(seenByTicker).reduce((a, b) => a + b, 0),
      seenByTicker,
      alarmAt: await this.ctx.storage.getAlarm(),
      lastRun,
      lastError: this.kvGet('lastError'),
      lastBatch: JSON.parse(this.kvGet('lastBatch') ?? 'null'),
    };
  }

  async listSeen(ticker: string): Promise<Record<string, unknown>[]> {
    return this.sql
      .exec('SELECT fid, date, time, title, form, keys, archived_at FROM seen WHERE ticker = ? ORDER BY date DESC, fid DESC', ticker)
      .toArray()
      .map((r) => ({ ...r, keys: JSON.parse(r.keys as string) }));
  }

  async listFailed(limit = 200): Promise<Record<string, unknown>[]> {
    return this.sql.exec('SELECT * FROM failed ORDER BY id DESC LIMIT ?', limit).toArray();
  }

  /** Move failed jobs back to the queue. */
  async retryFailed(): Promise<number> {
    const rows = this.sql.exec<{ id: number; kind: string; ticker: string; payload: string }>('SELECT id, kind, ticker, payload FROM failed').toArray();
    let n = 0;
    for (const r of rows) {
      const job = JSON.parse(r.payload) as Job;
      const dedupe = job.kind === 'download' ? `dl:${job.ref.ticker}:${job.ref.id}` : `${job.kind}:${r.ticker}:${Date.now()}:${r.id}`;
      if (this.enqueue(job, dedupe, r.ticker)) n++;
      this.sql.exec('DELETE FROM failed WHERE id = ?', r.id);
    }
    if (n) await this.ensureAlarm();
    return n;
  }

  /** Forget a filing so it is re-downloaded on the next sync (admin repair tool). */
  async forget(ticker: string, fid?: string): Promise<number> {
    const r = fid ? this.sql.exec('DELETE FROM seen WHERE ticker = ? AND fid = ?', ticker, fid) : this.sql.exec('DELETE FROM seen WHERE ticker = ?', ticker);
    return r.rowsWritten;
  }

  /** Kick the alarm (e.g. after a deploy) in case jobs are pending. */
  async kick(): Promise<void> {
    await this.ensureAlarm();
  }

  // ---------- processing ----------

  private makeContext(): SourceContext {
    const source = SOURCES[this.sourceId];
    const throttledFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      const slot = Math.max(this.nextSlotAt, Date.now());
      this.nextSlotAt = slot + source.minDelayMs;
      const wait = slot - Date.now();
      if (wait > 0) await sleep(wait);
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
          if (res.status === 429 || res.status === 503) {
            await sleep(2_000 * (attempt + 1));
            lastErr = new Error(`HTTP ${res.status} from ${url}`);
            continue;
          }
          return res;
        } catch (e) {
          lastErr = e;
          await sleep(1_000 * (attempt + 1));
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    };
    return {
      fetch: throttledFetch,
      now: () => new Date(),
      secUserAgent: this.env.SEC_USER_AGENT,
      secFullSubmission: this.env.SEC_FULL_SUBMISSION === 'true',
    };
  }

  async alarm(): Promise<void> {
    const started = Date.now();
    const source = SOURCES[this.sourceId];
    const concurrency = Math.max(1, source.concurrency ?? 1);
    const rows = this.sql.exec<JobRow>('SELECT * FROM jobs WHERE not_before <= ? ORDER BY id LIMIT ?', Date.now(), BATCH_JOBS).toArray();
    let next = 0;
    let processed = 0;
    const worker = async () => {
      while (next < rows.length && Date.now() - started < BATCH_WALL_MS) {
        const row = rows[next++];
        await this.processRow(row);
        processed++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
    this.kvSet('lastBatch', JSON.stringify({ at: new Date().toISOString(), jobs: processed, ms: Date.now() - started }));
    // Schedule the next batch: immediately if work is ready, else at the earliest retry time.
    const ready = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM jobs WHERE not_before <= ?', Date.now()).one().n;
    if (ready > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 1_000);
    } else {
      const next = this.sql.exec<{ t: number | null }>('SELECT MIN(not_before) AS t FROM jobs').one().t;
      if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1_000));
    }
  }

  private async processRow(row: JobRow): Promise<void> {
    const job = JSON.parse(row.payload) as Job;
    try {
      await this.runJob(job);
      this.sql.exec('DELETE FROM jobs WHERE id = ?', row.id);
    } catch (e) {
      const msg = e instanceof Error ? `${e.message}` : String(e);
      console.error(`[${this.sourceId}] job ${row.id} ${job.kind} ${row.ticker} failed (attempt ${row.attempts + 1}): ${msg}`);
      this.kvSet('lastError', `${new Date().toISOString()} ${job.kind} ${row.ticker}: ${msg}`.slice(0, 500));
      if (row.attempts + 1 >= MAX_ATTEMPTS) {
        this.sql.exec(
          'INSERT INTO failed (kind, ticker, payload, error, attempts, failed_at) VALUES (?, ?, ?, ?, ?, ?)',
          job.kind,
          row.ticker,
          row.payload,
          msg.slice(0, 2000),
          row.attempts + 1,
          Date.now(),
        );
        this.sql.exec('DELETE FROM jobs WHERE id = ?', row.id);
      } else {
        const backoff = Math.min(60 * 60_000, 30_000 * 2 ** row.attempts);
        this.sql.exec('UPDATE jobs SET attempts = attempts + 1, not_before = ? WHERE id = ?', Date.now() + backoff, row.id);
      }
    }
  }

  private async runJob(job: Job): Promise<void> {
    switch (job.kind) {
      case 'list':
        return this.runList(job);
      case 'download':
        return this.runDownload(job.ref);
      case 'export-index':
        return this.exportIndex(job.ticker);
    }
  }

  private async runList(job: Extract<Job, { kind: 'list' }>): Promise<void> {
    const source = SOURCES[this.sourceId];
    const holding = job.holding ?? (JSON.parse(this.kvGet(`holding:${job.ticker}`) ?? 'null') as Holding | null);
    if (!holding) throw new Error(`no holding config stored for ${job.ticker}`);
    const page = await source.list(holding, job.mode, job.cursor, this.makeContext());
    let queued = 0;
    for (const ref of page.refs) {
      if (ref.ticker !== holding.ticker) ref.ticker = holding.ticker;
      const exists = this.sql.exec('SELECT 1 FROM seen WHERE ticker = ? AND fid = ?', ref.ticker, ref.id).toArray().length > 0;
      if (exists) continue;
      if (this.enqueue({ kind: 'download', ref }, `dl:${ref.ticker}:${ref.id}`, ref.ticker)) queued++;
    }
    console.log(`[${this.sourceId}] list ${job.ticker} mode=${job.mode} cursor=${job.cursor ?? '-'}: ${page.refs.length} refs, ${queued} new`);
    if (page.nextCursor !== undefined) {
      this.enqueue({ kind: 'list', ticker: job.ticker, mode: job.mode, cursor: page.nextCursor, holding }, `list:${job.ticker}:${job.mode}:${page.nextCursor}`, job.ticker);
    } else {
      this.kvSet(`lastrun:${job.ticker}`, new Date().toISOString());
      this.enqueue({ kind: 'export-index', ticker: job.ticker }, `index:${job.ticker}:${Date.now()}`, job.ticker);
    }
  }

  private async runDownload(ref: FilingRef): Promise<void> {
    const source = SOURCES[this.sourceId];
    const objects: StoredObject[] = await source.download(ref, this.makeContext());
    if (!objects.length) throw new Error(`download of ${ref.ticker}/${ref.id} produced no objects`);
    const keys: string[] = [];
    for (const obj of objects) {
      const options: R2PutOptions = {
        httpMetadata: { contentType: obj.contentType },
        customMetadata: {
          source: ref.source,
          ticker: ref.ticker,
          id: ref.id,
          date: ref.date,
          form: (ref.form ?? '').slice(0, 100),
          title: ref.title.slice(0, 400),
        },
      };
      let size: number;
      if (obj.body instanceof ReadableStream) {
        size = await this.putStream(obj.key, obj.body, options);
      } else {
        size = typeof obj.body === 'string' ? new TextEncoder().encode(obj.body).byteLength : obj.body.byteLength;
        if (size > MAX_OBJECT_BYTES) throw new Error(`${obj.key} is ${size} bytes, over the limit`);
        await this.env.FILINGS.put(obj.key, obj.body, options);
      }
      const meta = { ...ref, ...obj.meta, key: obj.key, contentType: obj.contentType, bytes: size, archivedAt: new Date().toISOString() };
      await this.env.FILINGS.put(`${obj.key}.meta.json`, JSON.stringify(meta, null, 2), { httpMetadata: { contentType: 'application/json' } });
      keys.push(obj.key);
    }
    this.sql.exec(
      'INSERT INTO seen (ticker, fid, date, time, title, form, keys, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ticker, fid) DO UPDATE SET keys = excluded.keys, archived_at = excluded.archived_at',
      ref.ticker,
      ref.id,
      ref.date,
      ref.time ?? null,
      ref.title,
      ref.form ?? null,
      JSON.stringify(keys),
      Date.now(),
    );
  }

  /**
   * Write a stream to R2 as a multipart upload in fixed-size parts, so that objects
   * larger than the Worker's memory never have to be buffered whole. Returns the byte count.
   */
  private async putStream(key: string, stream: ReadableStream<Uint8Array>, options: R2PutOptions): Promise<number> {
    const PART = 8 * 1024 * 1024;
    const upload = await this.env.FILINGS.createMultipartUpload(key, options);
    const parts: R2UploadedPart[] = [];
    const chunks: Uint8Array[] = [];
    let buffered = 0;
    let total = 0;
    const flush = async () => {
      const part = new Uint8Array(buffered);
      let off = 0;
      for (const c of chunks) {
        part.set(c, off);
        off += c.byteLength;
      }
      parts.push(await upload.uploadPart(parts.length + 1, part));
      chunks.length = 0;
      buffered = 0;
    };
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_OBJECT_BYTES) throw new Error(`${key} exceeds ${MAX_OBJECT_BYTES} bytes`);
        // Keep every non-final part exactly PART bytes (R2 requires equal-sized parts except the last).
        let v = value;
        while (buffered + v.byteLength >= PART) {
          const take = PART - buffered;
          chunks.push(v.subarray(0, take));
          buffered += take;
          await flush();
          v = v.subarray(take);
        }
        if (v.byteLength) {
          chunks.push(v);
          buffered += v.byteLength;
        }
      }
      if (buffered > 0 || parts.length === 0) await flush();
      await upload.complete(parts);
    } catch (e) {
      await upload.abort().catch(() => {});
      throw e;
    } finally {
      reader.releaseLock();
    }
    return total;
  }

  private async exportIndex(ticker: string): Promise<void> {
    const filings = await this.listSeen(ticker);
    const doc = { source: this.sourceId, ticker, count: filings.length, generatedAt: new Date().toISOString(), filings };
    await this.env.FILINGS.put(`_index/${this.sourceId}/${ticker}.json`, JSON.stringify(doc, null, 2), {
      httpMetadata: { contentType: 'application/json' },
    });
  }
}
