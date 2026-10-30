/**
 * Holdings loading, shard routing and "queue a sync of every holding" logic,
 * kept free of Durable Object imports so it is unit-testable.
 */
import holdingsJson from '../holdings.json';
import type { Holding, HoldingsConfig, SourceId, SyncMode } from './types';
import { SOURCES, SOURCE_IDS } from './sources';

/** The subset of the Crawler RPC surface that queueing needs. */
export interface CrawlerLike {
  enqueueSyncMany(holdings: Holding[], mode: SyncMode): Promise<{ queued: string[]; skipped: string[]; full: number; recent: number }>;
}

export interface SyncEnv {
  HOLDINGS_JSON?: string;
  CRAWLER: { get(id: DurableObjectId): unknown; idFromName(name: string): DurableObjectId };
  FILINGS?: { get(key: string): Promise<{ json(): Promise<unknown> } | null> };
}

export const UNIVERSE_KEY = '_universe/universe.json';

/** The hand-maintained portfolio (holdings.json, or HOLDINGS_JSON var). */
export function loadHoldings(env: { HOLDINGS_JSON?: string }): Holding[] {
  const cfg = (env.HOLDINGS_JSON ? JSON.parse(env.HOLDINGS_JSON) : holdingsJson) as HoldingsConfig;
  return cfg.holdings;
}

/** Portfolio plus the automatically discovered universe stored in R2 (portfolio entries win on ticker clashes). */
export async function loadAllHoldings(env: SyncEnv): Promise<Holding[]> {
  const portfolio = loadHoldings(env);
  const seen = new Set(portfolio.map((h) => h.ticker));
  const out = [...portfolio];
  try {
    const obj = await env.FILINGS?.get(UNIVERSE_KEY);
    if (obj) {
      const u = (await obj.json()) as { holdings?: Holding[] };
      for (const h of u.holdings ?? []) if (!seen.has(h.ticker)) { seen.add(h.ticker); out.push(h); }
    }
  } catch (e) {
    console.error(`could not load universe: ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}

export function shardCount(source: SourceId): number {
  return Math.max(1, SOURCES[source].shards ?? 1);
}

/** Durable Object name for a (source, shard): "asx" for shard 0, "asx#3" for others. */
export function shardName(source: SourceId, shard: number): string {
  return shard > 0 ? `${source}#${shard}` : source;
}

export function allShardNames(source: SourceId): string[] {
  return Array.from({ length: shardCount(source) }, (_, i) => shardName(source, i));
}

/** FNV-1a hash → stable shard assignment for discovered holdings. */
export function hashShard(ticker: string, shards: number): number {
  let h = 0x811c9dc5;
  for (const ch of ticker) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return shards <= 1 ? 0 : h % shards;
}

export function crawlerNameFor(source: SourceId, holding: Holding): string {
  const n = shardCount(source);
  const shard = Math.min(Math.max(holding.shard ?? 0, 0), n - 1);
  return shardName(source, shard);
}

export function crawlerByName(env: SyncEnv, name: string): CrawlerLike {
  return env.CRAWLER.get(env.CRAWLER.idFromName(name)) as CrawlerLike;
}

export interface QueueResult {
  mode: SyncMode;
  holdings: number;
  queued: string[];
  skipped: string[];
  full: number;
  recent: number;
  errors: string[];
}

/** Queue a sync for every (holding, source) pair, grouped into one RPC per Durable Object. */
export async function queueAll(env: SyncEnv, mode: SyncMode, holdings: Holding[], only?: string, onlySource?: string, onlyShard?: string): Promise<QueueResult> {
  const selected = holdings.filter((h) => !only || h.ticker.toUpperCase() === only.toUpperCase());
  const groups = new Map<string, Holding[]>();
  for (const h of selected) {
    for (const s of h.sources) {
      if (onlySource && s !== onlySource) continue;
      if (!SOURCE_IDS.includes(s)) continue;
      const name = crawlerNameFor(s, h);
      if (onlyShard && name !== onlyShard) continue;
      const g = groups.get(name) ?? [];
      g.push(h);
      groups.set(name, g);
    }
  }
  const result: QueueResult = { mode, holdings: selected.length, queued: [], skipped: [], full: 0, recent: 0, errors: [] };
  for (const [name, hs] of groups) {
    try {
      const r = await crawlerByName(env, name).enqueueSyncMany(hs, mode);
      result.queued.push(...r.queued.map((q) => `${name}:${q}`));
      result.skipped.push(...r.skipped.map((q) => `${name}:${q}`));
      result.full += r.full;
      result.recent += r.recent;
    } catch (e) {
      result.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}
