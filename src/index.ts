/**
 * stock-cloud filings archiver — Worker entry point.
 *
 *  - Cron (daily): queue a "recent" sync of every holding on every source.
 *  - HTTP admin API (Bearer ADMIN_TOKEN for anything that mutates):
 *      GET  /                      overview + help
 *      GET  /status                queue / archive counts per source
 *      GET  /holdings              the configured portfolio
 *      GET  /index/:source/:ticker archived filings for one holding (from the DO)
 *      GET  /failed/:source        permanently failed jobs
 *      POST /backfill              full-history sync of every holding (first run)
 *      POST /sync?ticker=X&mode=full|recent   sync one holding
 *      POST /retry/:source         re-queue failed jobs
 *      POST /forget/:source/:ticker[?id=]     forget archived filings so they are fetched again
 */
import type { Env, ListMode, SourceId } from './types';
import { SOURCE_IDS } from './sources';
import type { Crawler } from './crawler';
import { loadHoldings, queueAll } from './sync';

export { Crawler } from './crawler';

function crawler(env: Env, source: SourceId): DurableObjectStub<Crawler> {
  return env.CRAWLER.get(env.CRAWLER.idFromName(source)) as unknown as DurableObjectStub<Crawler>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function authorised(req: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const h = req.headers.get('authorization') || '';
  return h === `Bearer ${env.ADMIN_TOKEN}`;
}

function isSource(s: string): s is SourceId {
  return (SOURCE_IDS as string[]).includes(s);
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      queueAll(env, 'recent').then((r) => console.log(`daily sync queued: ${JSON.stringify(r)}`)),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method.toUpperCase();

    if (method === 'GET' && parts.length === 0) {
      return json({
        service: 'stock-cloud filings archiver',
        bucket: 'stock-filings',
        sources: SOURCE_IDS,
        holdings: loadHoldings(env).length,
        endpoints: ['GET /status', 'GET /holdings', 'GET /index/:source/:ticker', 'GET /failed/:source', 'POST /backfill', 'POST /sync?ticker=&source=&mode=', 'POST /retry/:source', 'POST /forget/:source/:ticker?id=', 'POST /probe {url,headers}', 'POST /kick'],
      });
    }
    if (method === 'GET' && parts[0] === 'status') {
      const out: Record<string, unknown> = {};
      for (const s of SOURCE_IDS) {
        try {
          out[s] = await crawler(env, s).status();
        } catch (e) {
          out[s] = { error: e instanceof Error ? e.message : String(e) };
        }
      }
      return json(out);
    }
    if (method === 'GET' && parts[0] === 'holdings') return json(loadHoldings(env));
    if (method === 'GET' && parts[0] === 'index' && parts.length === 3 && isSource(parts[1])) {
      return json(await crawler(env, parts[1]).listSeen(parts[2].toUpperCase()));
    }
    if (method === 'GET' && parts[0] === 'failed' && parts.length === 2 && isSource(parts[1])) {
      return json(await crawler(env, parts[1]).listFailed());
    }

    if (method !== 'POST') return json({ error: 'not found' }, 404);
    if (!authorised(req, env)) return json({ error: 'unauthorised: send Authorization: Bearer <ADMIN_TOKEN>' }, 401);

    if (parts[0] === 'backfill') return json(await queueAll(env, 'full'));
    if (parts[0] === 'sync') {
      const ticker = url.searchParams.get('ticker') || undefined;
      const source = url.searchParams.get('source') || undefined;
      const mode = (url.searchParams.get('mode') || 'recent') as ListMode;
      if (mode !== 'full' && mode !== 'recent') return json({ error: 'mode must be full or recent' }, 400);
      if (source && !isSource(source)) return json({ error: `unknown source ${source}` }, 400);
      return json(await queueAll(env, mode, ticker, source));
    }
    if (parts[0] === 'retry' && parts.length === 2 && isSource(parts[1])) {
      return json({ requeued: await crawler(env, parts[1]).retryFailed() });
    }
    if (parts[0] === 'forget' && parts.length === 3 && isSource(parts[1])) {
      const id = url.searchParams.get('id') || undefined;
      return json({ forgotten: await crawler(env, parts[1]).forget(parts[2].toUpperCase(), id) });
    }
    if (parts[0] === 'probe') {
      // Diagnostic: fetch a URL from the Worker's egress with optional headers (JSON body: {url, headers}).
      const body = (await req.json().catch(() => ({}))) as { url?: string; headers?: Record<string, string>; maxChars?: number };
      if (!body.url) return json({ error: 'url required' }, 400);
      const r = await fetch(body.url, { headers: body.headers ?? {}, redirect: 'manual' });
      const text = await r.text();
      return json({ status: r.status, headers: Object.fromEntries(r.headers), bodyStart: text.slice(0, Math.min(body.maxChars ?? 600, 2_000_000)), bytes: text.length });
    }
    if (parts[0] === 'kick') {
      for (const s of SOURCE_IDS) await crawler(env, s).kick();
      return json({ kicked: SOURCE_IDS });
    }
    return json({ error: 'not found' }, 404);
  },
} satisfies ExportedHandler<Env>;
