/**
 * stock-cloud filings archiver — Worker entry point.
 *
 *  - Cron (daily): rebuild the ASX universe, then queue an "auto" sync of every holding
 *    on every source (full backfill for codes never listed before, recent otherwise).
 *  - HTTP admin API (Bearer ADMIN_TOKEN for anything that mutates):
 *      GET  /                      overview + help
 *      GET  /status                queue / archive counts per source (shards aggregated)
 *      GET  /holdings              portfolio + universe
 *      GET  /universe              the discovered universe document
 *      GET  /index/:source/:ticker archived filings for one holding
 *      GET  /failed/:source        permanently failed jobs
 *      POST /universe/refresh      rebuild the universe now
 *      POST /backfill              full-history sync of every holding
 *      POST /sync?ticker=X&source=Y&mode=full|recent|auto
 *      POST /retry/:source         re-queue failed jobs
 *      POST /forget/:source/:ticker[?id=]
 *      POST /probe {url, headers, maxChars}  fetch a URL from the Worker's egress (diagnostics)
 *      POST /kick                  re-arm the alarms (after a deploy)
 */
import type { Env, Holding, SourceId, SyncMode } from './types';
import { SOURCE_IDS } from './sources';
import type { Crawler, SourceStatus } from './crawler';
import { allShardNames, crawlerNameFor, loadAllHoldings, loadHoldings, queueAll, UNIVERSE_KEY } from './sync';
import { buildUniverse, type UniverseDoc } from './universe';

export { Crawler } from './crawler';

function crawler(env: Env, name: string): DurableObjectStub<Crawler> {
  return env.CRAWLER.get(env.CRAWLER.idFromName(name)) as unknown as DurableObjectStub<Crawler>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function authorised(req: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  return (req.headers.get('authorization') || '') === `Bearer ${env.ADMIN_TOKEN}`;
}

function isSource(s: string): s is SourceId {
  return (SOURCE_IDS as string[]).includes(s);
}

async function refreshUniverse(env: Env): Promise<UniverseDoc> {
  const exclude = new Set(loadHoldings(env).map((h) => h.ticker));
  const doc = await buildUniverse({ fetch: (u, i) => fetch(u, i), now: () => new Date() }, exclude);
  await env.FILINGS.put(UNIVERSE_KEY, JSON.stringify(doc, null, 2), { httpMetadata: { contentType: 'application/json' } });
  await env.FILINGS.put(`_universe/history/${doc.generatedAt.slice(0, 10)}.json`, JSON.stringify(doc), { httpMetadata: { contentType: 'application/json' } });
  return doc;
}

function sumStatus(parts: SourceStatus[]): Record<string, unknown> {
  const sum = (k: keyof SourceStatus) => parts.reduce((a, p) => a + ((p[k] as number) || 0), 0);
  const merge = (k: 'pendingByKind' | 'pendingByTicker' | 'seenByTicker') => {
    const out: Record<string, number> = {};
    for (const p of parts) for (const [kk, v] of Object.entries(p[k] ?? {})) out[kk] = (out[kk] ?? 0) + v;
    return out;
  };
  return {
    source: parts[0]?.source,
    shards: parts.map((p) => ({ shard: p.shard, pendingJobs: p.pendingJobs, seen: p.seen, failedJobs: p.failedJobs, lastBatch: p.lastBatch, lastError: p.lastError })),
    pendingJobs: sum('pendingJobs'),
    pendingByKind: merge('pendingByKind'),
    failedJobs: sum('failedJobs'),
    seen: sum('seen'),
    seenByTicker: merge('seenByTicker'),
    recentJobs: parts.flatMap((p) => p.recentJobs ?? []).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 40),
  };
}

async function findHolding(env: Env, ticker: string): Promise<Holding | undefined> {
  const all = await loadAllHoldings(env);
  return all.find((h) => h.ticker === ticker.toUpperCase());
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const u = await refreshUniverse(env);
          console.log(`universe refreshed: ${JSON.stringify(u.counts)}`);
        } catch (e) {
          console.error(`universe refresh failed, using the stored one: ${e instanceof Error ? e.message : String(e)}`);
        }
        const r = await queueAll(env, 'auto', await loadAllHoldings(env));
        console.log(`daily sync queued: holdings=${r.holdings} queued=${r.queued.length} full=${r.full} recent=${r.recent} errors=${JSON.stringify(r.errors)}`);
      })(),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method.toUpperCase();

    if (method === 'GET' && parts.length === 0) {
      const all = await loadAllHoldings(env);
      return json({
        service: 'stock-cloud filings archiver',
        bucket: 'stock-filings',
        sources: SOURCE_IDS,
        holdings: { portfolio: loadHoldings(env).length, total: all.length },
        endpoints: ['GET /status', 'GET /holdings', 'GET /universe', 'GET /index/:source/:ticker', 'GET /failed/:source', 'POST /universe/refresh', 'POST /backfill', 'POST /sync?ticker=&source=&shard=&mode=full|recent|auto', 'POST /retry/:source', 'POST /forget/:source/:ticker?id=', 'POST /probe {url,headers,maxChars}', 'POST /kick'],
      });
    }
    if (method === 'GET' && parts[0] === 'status') {
      const out: Record<string, unknown> = {};
      for (const s of SOURCE_IDS) {
        try {
          const statuses = await Promise.all(allShardNames(s).map((n) => crawler(env, n).status()));
          out[s] = sumStatus(statuses);
        } catch (e) {
          out[s] = { error: e instanceof Error ? e.message : String(e) };
        }
      }
      return json(out);
    }
    if (method === 'GET' && parts[0] === 'holdings') return json(await loadAllHoldings(env));
    if (method === 'GET' && parts[0] === 'universe') {
      const obj = await env.FILINGS.get(UNIVERSE_KEY);
      return obj ? new Response(obj.body, { headers: { 'content-type': 'application/json' } }) : json({ error: 'no universe built yet' }, 404);
    }
    if (method === 'GET' && parts[0] === 'index' && parts.length === 3 && isSource(parts[1])) {
      const h = await findHolding(env, parts[2]);
      const name = h ? crawlerNameFor(parts[1], h) : parts[1];
      return json(await crawler(env, name).listSeen(parts[2].toUpperCase()));
    }
    if (method === 'GET' && parts[0] === 'failed' && parts.length === 2 && isSource(parts[1])) {
      const lists = await Promise.all(allShardNames(parts[1]).map((n) => crawler(env, n).listFailed()));
      return json(lists.flat());
    }

    if (method !== 'POST') return json({ error: 'not found' }, 404);
    if (!authorised(req, env)) return json({ error: 'unauthorised: send Authorization: Bearer <ADMIN_TOKEN>' }, 401);

    if (parts[0] === 'universe' && parts[1] === 'refresh') {
      const doc = await refreshUniverse(env);
      return json({ generatedAt: doc.generatedAt, counts: doc.counts, sources: doc.sources });
    }
    if (parts[0] === 'backfill') return json(await queueAll(env, 'full', await loadAllHoldings(env)));
    if (parts[0] === 'sync') {
      const ticker = url.searchParams.get('ticker') || undefined;
      const source = url.searchParams.get('source') || undefined;
      const mode = (url.searchParams.get('mode') || 'auto') as SyncMode;
      if (mode !== 'full' && mode !== 'recent' && mode !== 'auto') return json({ error: 'mode must be full, recent or auto' }, 400);
      if (source && !isSource(source)) return json({ error: `unknown source ${source}` }, 400);
      const shard = url.searchParams.get('shard') || undefined; // a Durable Object name such as "asx#3"
      return json(await queueAll(env, mode, await loadAllHoldings(env), ticker, source, shard));
    }
    if (parts[0] === 'retry' && parts.length === 2 && isSource(parts[1])) {
      const ns = await Promise.all(allShardNames(parts[1]).map((n) => crawler(env, n).retryFailed()));
      return json({ requeued: ns.reduce((a, b) => a + b, 0) });
    }
    if (parts[0] === 'forget' && parts.length === 3 && isSource(parts[1])) {
      const id = url.searchParams.get('id') || undefined;
      const h = await findHolding(env, parts[2]);
      const name = h ? crawlerNameFor(parts[1], h) : parts[1];
      return json({ forgotten: await crawler(env, name).forget(parts[2].toUpperCase(), id) });
    }
    if (parts[0] === 'probe') {
      const body = (await req.json().catch(() => ({}))) as { url?: string; headers?: Record<string, string>; maxChars?: number };
      if (!body.url) return json({ error: 'url required' }, 400);
      const r = await fetch(body.url, { headers: body.headers ?? {}, redirect: 'manual' });
      const text = await r.text();
      return json({ status: r.status, headers: Object.fromEntries(r.headers), bodyStart: text.slice(0, Math.min(body.maxChars ?? 600, 2_000_000)), bytes: text.length });
    }
    if (parts[0] === 'kick') {
      const names = SOURCE_IDS.flatMap((s) => allShardNames(s));
      for (const n of names) await crawler(env, n).kick();
      return json({ kicked: names });
    }
    return json({ error: 'not found' }, 404);
  },
} satisfies ExportedHandler<Env>;
