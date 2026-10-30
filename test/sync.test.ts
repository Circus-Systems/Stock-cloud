import { describe, it, expect } from 'vitest';
import { loadHoldings, loadAllHoldings, queueAll, hashShard, crawlerNameFor, allShardNames } from '../src/sync';
import type { Holding, SyncMode } from '../src/types';

type Enqueue = (name: string, hs: Holding[], mode: SyncMode) => Promise<{ queued: string[]; skipped: string[]; full: number; recent: number }>;
function fakeEnv(enqueue: Enqueue, universe?: Holding[]) {
  return {
    CRAWLER: {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: (id: DurableObjectId) => ({ enqueueSyncMany: (hs: Holding[], mode: SyncMode) => enqueue((id as unknown as { name: string }).name, hs, mode) }),
    },
    FILINGS: { get: async (key: string) => (universe && key === '_universe/universe.json' ? { json: async () => ({ holdings: universe }) } : null) },
  };
}
const ok: Enqueue = async (_n, hs, mode) => ({ queued: hs.map((h) => `${h.ticker}:${mode}`), skipped: [], full: mode === 'full' ? hs.length : 0, recent: mode === 'recent' ? hs.length : 0 });

describe('holdings config', () => {
  const holdings = loadHoldings({});
  it('covers the whole portfolio with a valid source configuration', () => {
    expect(holdings.length).toBe(57);
    for (const h of holdings) {
      expect(h.sources.length).toBeGreaterThan(0);
      if (h.sources.includes('sec')) expect(h.cik).toMatch(/^\d+$/);
      if (h.sources.includes('rns')) expect(h.brighterir).toBeTruthy();
    }
    expect(new Set(holdings.map((h) => h.ticker)).size).toBe(holdings.length);
  });
  it('maps ASX hybrids to their issuer codes and dual listings to SEC too', () => {
    const by = Object.fromEntries(holdings.map((h) => [h.ticker, h]));
    expect(by.GSBE47.asxArchiveCode).toBe('GSB');
    expect(by.BHP.sources).toEqual(['asx', 'sec', 'prices']);
    expect(by.RMV.sources).toEqual(['rns', 'prices']);
    expect(by.ADYEN.sources).toEqual(['adyen', 'prices']);
    expect(holdings.every((h) => h.sources.includes('prices'))).toBe(true);
  });
  it('can be overridden with HOLDINGS_JSON', () => {
    const h = loadHoldings({ HOLDINGS_JSON: JSON.stringify({ holdings: [{ ticker: 'X', exchange: 'XNAS', sources: ['sec'], cik: '1' }] }) });
    expect(h).toHaveLength(1);
  });
  it('merges the stored universe, portfolio entries winning', async () => {
    const all = await loadAllHoldings(fakeEnv(ok, [
      { ticker: 'CBA', exchange: 'XASX', sources: ['asx', 'prices'], universe: ['asx300'], shard: 3 },
      { ticker: 'BHP', exchange: 'XASX', sources: ['asx'], universe: ['asx300'] },
    ]));
    expect(all.length).toBe(58);
    expect(all.find((h) => h.ticker === 'BHP')!.sources).toContain('sec');
    expect(all.find((h) => h.ticker === 'CBA')!.shard).toBe(3);
  });
});

describe('sharding', () => {
  it('is stable and bounded', () => {
    expect(hashShard('BHP', 6)).toBe(hashShard('BHP', 6));
    for (const t of ['BHP', 'CBA', 'VAS', 'A200', 'GSBE47']) expect(hashShard(t, 6)).toBeLessThan(6);
    expect(hashShard('BHP', 1)).toBe(0);
  });
  it('routes shard 0 to the plain source name and others to source#n', () => {
    expect(allShardNames('asx')).toEqual(['asx', 'asx#1', 'asx#2', 'asx#3', 'asx#4', 'asx#5']);
    expect(allShardNames('sec')).toEqual(['sec']);
    expect(crawlerNameFor('asx', { ticker: 'BHP', exchange: 'XASX', sources: ['asx'] })).toBe('asx');
    expect(crawlerNameFor('asx', { ticker: 'CBA', exchange: 'XASX', sources: ['asx'], shard: 4 })).toBe('asx#4');
    expect(crawlerNameFor('prices', { ticker: 'CBA', exchange: 'XASX', sources: ['prices'], shard: 4 })).toBe('prices');
  });
});

describe('queueAll (what the daily cron does)', () => {
  it('queues every holding on each of its sources, one RPC per Durable Object', async () => {
    const calls: string[] = [];
    const env = fakeEnv(async (n, hs, mode) => { calls.push(`${n}:${hs.length}:${mode}`); return ok(n, hs, mode); });
    const r = await queueAll(env, 'auto', loadHoldings({}));
    expect(r.holdings).toBe(57);
    expect(r.queued.length).toBe(117); // 57 holdings on prices + 57 filing sources + 3 dual listings
    expect(r.errors).toEqual([]);
    expect(calls).toContain('sec:16:auto');
    expect(calls).toContain('asx:42:auto');
    expect(calls).toContain('prices:57:auto');
    expect(calls).toContain('rns:1:auto');
  });
  it('spreads universe holdings over the asx shards', async () => {
    const calls: string[] = [];
    const universe: Holding[] = Array.from({ length: 60 }, (_, i) => ({ ticker: `U${i}`, exchange: 'XASX', sources: ['asx', 'prices'], shard: i % 6 }));
    const env = fakeEnv(async (n, hs, mode) => { calls.push(n); return ok(n, hs, mode); }, universe);
    const r = await queueAll(env, 'auto', await loadAllHoldings(env), undefined, 'asx');
    expect(r.queued.length).toBe(42 + 60);
    expect(new Set(calls)).toEqual(new Set(['asx', 'asx#1', 'asx#2', 'asx#3', 'asx#4', 'asx#5']));
  });
  it('filters to one ticker and reports stub errors without aborting', async () => {
    const env = fakeEnv(async (n, hs, mode) => { if (n === 'sec') throw new Error('boom'); return { queued: [], skipped: hs.map((h) => `${h.ticker}:${mode}`), full: 0, recent: 0 }; });
    const r = await queueAll(env, 'full', loadHoldings({}), 'bhp');
    expect(r.holdings).toBe(1);
    expect(r.skipped).toEqual(['asx:BHP:full', 'prices:BHP:full']);
    expect(r.errors).toEqual(['sec: boom']);
  });
  it('can be limited to one source', async () => {
    const r = await queueAll(fakeEnv(ok), 'full', loadHoldings({}), undefined, 'prices');
    expect(r.queued.length).toBe(57);
  });
});
