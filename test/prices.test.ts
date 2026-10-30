import { describe, it, expect } from 'vitest';
import { pricesSource, parseChart, toCsv, yahooSymbol, chartUrl } from '../src/sources/prices';
import type { Holding, SourceContext } from '../src/types';

// Shape of https://query1.finance.yahoo.com/v8/finance/chart/BHP.AX?period1=0&period2=...&interval=1d&events=div,split
const chart = {
  chart: {
    result: [
      {
        meta: { currency: 'AUD', symbol: 'BHP.AX', exchangeName: 'ASX', fullExchangeName: 'ASX', exchangeTimezoneName: 'Australia/Sydney', instrumentType: 'EQUITY', longName: 'BHP Group Limited' },
        // 2026-10-28 00:00 AEDT, 2026-10-29, 2026-10-30 (10:00 AEDT opens = 23:00 UTC previous day)
        timestamp: [1793181600, 1793268000, 1793354400, 1793440800],
        events: {
          dividends: { '1793268000': { amount: 0.5123, date: 1793268000 } },
          splits: { '1793354400': { numerator: 2, denominator: 1, splitRatio: '2:1', date: 1793354400 } },
        },
        indicators: {
          quote: [{ open: [57.0, 57.5, 56.9, null], high: [58.0, 58.1, 57.6, null], low: [56.5, 57.1, 56.5, null], close: [57.52, 57.9, 57.3, null], volume: [1000000, 900000, 1234567, null] }],
          adjclose: [{ adjclose: [57.0, 57.4, 57.3, null] }],
        },
      },
    ],
    error: null,
  },
};

const bhp: Holding = { ticker: 'BHP', exchange: 'XASX', sources: ['prices'] };
const ctx = (handler: (url: string) => Response): SourceContext => ({ fetch: async (u) => handler(u), now: () => new Date('2026-10-30T10:00:00Z') });

describe('prices source', () => {
  it('maps exchanges to Yahoo symbols', () => {
    expect(yahooSymbol(bhp)).toBe('BHP.AX');
    expect(yahooSymbol({ ticker: 'RMV', exchange: 'XLON', sources: ['prices'] })).toBe('RMV.L');
    expect(yahooSymbol({ ticker: 'ADYEN', exchange: 'XAMS', sources: ['prices'] })).toBe('ADYEN.AS');
    expect(yahooSymbol({ ticker: 'AAPL', exchange: 'XNAS', sources: ['prices'] })).toBe('AAPL');
    expect(yahooSymbol({ ticker: 'X', exchange: 'XNAS', sources: ['prices'], yahoo: 'XYZ.AX' })).toBe('XYZ.AX');
    expect(() => yahooSymbol({ ticker: 'X', exchange: 'XTSE', sources: ['prices'] })).toThrow(/XTSE/);
  });

  it('asks for explicit period bounds (range=max coarsens the bars)', () => {
    const u = chartUrl('BHP.AX', new Date('2026-10-30T10:00:00Z'));
    expect(u).toContain('period1=0&period2=');
    expect(u).toContain('interval=1d');
    expect(u).toContain('events=div%2Csplit');
    expect(u).not.toContain('range=');
  });

  it('parses bars with exchange-local dates, dividends and splits, dropping empty bars', () => {
    const s = parseChart(chart, 'BHP.AX');
    expect(s.currency).toBe('AUD');
    expect(s.rows.map((r) => r.date)).toEqual(['2026-10-28', '2026-10-29', '2026-10-30']);
    expect(s.rows[1].dividend).toBe(0.5123);
    expect(s.rows[2].split).toBe('2:1');
    expect(s.rows[0].adjclose).toBe(57.0);
    const csv = toCsv(s);
    expect(csv.split('\n')[0]).toBe('date,open,high,low,close,adjclose,volume,dividend,split');
    expect(csv).toContain('2026-10-29,57.5,58.1,57.1,57.9,57.4,900000,0.5123,\n');
    expect(csv).toContain('2026-10-30,56.9,57.6,56.5,57.3,57.3,1234567,,2:1\n');
  });

  it('surfaces Yahoo errors', () => {
    expect(() => parseChart({ chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } }, 'X')).toThrow(/delisted/);
  });

  it('lists one refresh per day and writes csv + json', async () => {
    const page = await pricesSource.list(bhp, 'recent', undefined, ctx(() => new Response('')));
    expect(page.refs).toHaveLength(1);
    expect(page.refs[0].id).toBe('refresh-2026-10-30');
    expect(page.nextCursor).toBeUndefined();
    const objs = await pricesSource.download(page.refs[0], ctx(() => new Response(JSON.stringify(chart), { headers: { 'content-type': 'application/json' } })));
    expect(objs.map((o) => o.key)).toEqual(['prices/BHP.json', 'prices/BHP.csv']);
    expect(objs[0].meta).toMatchObject({ bars: 3, firstDate: '2026-10-28', lastDate: '2026-10-30', currency: 'AUD' });
  });

  it('writes only the json when a symbol has no history (ASX bonds)', async () => {
    const empty = { chart: { result: [{ meta: { currency: 'AUD', exchangeTimezoneName: 'Australia/Sydney' }, indicators: { quote: [{}] } }], error: null } };
    const [ref] = (await pricesSource.list(bhp, 'recent', undefined, ctx(() => new Response('')))).refs;
    const objs = await pricesSource.download(ref, ctx(() => new Response(JSON.stringify(empty))));
    expect(objs.map((o) => o.key)).toEqual(['prices/BHP.json']);
  });
});
