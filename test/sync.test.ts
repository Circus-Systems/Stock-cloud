import { describe, it, expect } from 'vitest';
import { loadHoldings, queueAll } from '../src/sync';
import type { Holding } from '../src/types';

function fakeEnv(enqueue: (source: string, h: Holding, mode: string) => Promise<boolean>) {
  return {
    CRAWLER: {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: (id: DurableObjectId) => ({ enqueueSync: (h: Holding, mode: string) => enqueue((id as unknown as { name: string }).name, h, mode) }),
    },
  };
}

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
    expect(by.BHP.sources).toEqual(['asx', 'sec']);
    expect(by.RMV.sources).toEqual(['rns']);
    expect(by.ADYEN.sources).toEqual(['adyen']);
  });
  it('can be overridden with HOLDINGS_JSON', () => {
    const h = loadHoldings({ HOLDINGS_JSON: JSON.stringify({ holdings: [{ ticker: 'X', exchange: 'XNAS', sources: ['sec'], cik: '1' }] }) });
    expect(h).toHaveLength(1);
  });
});

describe('queueAll (what the daily cron does)', () => {
  it('queues every holding on each of its sources in recent mode', async () => {
    const calls: string[] = [];
    const r = await queueAll(fakeEnv(async (s, h, m) => { calls.push(`${s}:${h.ticker}:${m}`); return true; }), 'recent');
    expect(r.holdings).toBe(57);
    expect(r.queued.length).toBe(60); // 57 holdings, 3 of them on two sources
    expect(r.errors).toEqual([]);
    expect(calls).toContain('sec:MSFT:recent');
    expect(calls).toContain('asx:BHP:recent');
    expect(calls).toContain('sec:BHP:recent');
    expect(calls).toContain('rns:RMV:recent');
    expect(calls).toContain('adyen:ADYEN:recent');
  });
  it('filters to one ticker and reports stub errors without aborting', async () => {
    const r = await queueAll(fakeEnv(async (s) => { if (s === 'sec') throw new Error('boom'); return false; }), 'full', 'bhp');
    expect(r.holdings).toBe(1);
    expect(r.queued).toEqual(['asx:BHP (already queued)']);
    expect(r.errors).toEqual(['sec:BHP: boom']);
  });
});
