/** Holdings loading and the "queue a sync of every holding" logic, kept free of Durable Object imports so it is unit-testable. */
import holdingsJson from '../holdings.json';
import type { Holding, HoldingsConfig, ListMode, SourceId } from './types';

/** The subset of the Crawler RPC surface that queueing needs. */
export interface CrawlerLike {
  enqueueSync(holding: Holding, mode: ListMode): Promise<boolean>;
}

export interface SyncEnv {
  HOLDINGS_JSON?: string;
  CRAWLER: { get(id: DurableObjectId): unknown; idFromName(name: string): DurableObjectId };
}

export function loadHoldings(env: { HOLDINGS_JSON?: string }): Holding[] {
  const cfg = (env.HOLDINGS_JSON ? JSON.parse(env.HOLDINGS_JSON) : holdingsJson) as HoldingsConfig;
  return cfg.holdings;
}

export function crawlerFor(env: SyncEnv, source: SourceId): CrawlerLike {
  return env.CRAWLER.get(env.CRAWLER.idFromName(source)) as CrawlerLike;
}

export async function queueAll(env: SyncEnv, mode: ListMode, only?: string): Promise<{ mode: ListMode; holdings: number; queued: string[]; errors: string[] }> {
  const holdings = loadHoldings(env).filter((h) => !only || h.ticker.toUpperCase() === only.toUpperCase());
  const queued: string[] = [];
  const errors: string[] = [];
  for (const h of holdings) {
    for (const s of h.sources) {
      try {
        const fresh = await crawlerFor(env, s).enqueueSync(h, mode);
        queued.push(`${s}:${h.ticker}${fresh ? '' : ' (already queued)'}`);
      } catch (e) {
        errors.push(`${s}:${h.ticker}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { mode, holdings: holdings.length, queued, errors };
}
