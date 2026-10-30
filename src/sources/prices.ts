/**
 * Daily price history from Yahoo Finance's chart endpoint (unofficial, free, covers
 * US / ASX / LSE / Euronext with one symbol scheme).
 *
 * Each run re-downloads the complete daily history of a holding and overwrites
 *   prices/{TICKER}.csv   date,open,high,low,close,adjclose,volume,dividend,split
 *   prices/{TICKER}.json  symbol, currency, exchange, bar count, first/last date
 * Re-downloading everything each day keeps adjusted closes consistent after
 * dividends/splits and costs one small request per holding.
 *
 * Note: `range=max` silently coarsens the bars; explicit period1/period2 returns
 * every daily bar.
 */
import type { FilingRef, Holding, ListMode, ListPage, Source, SourceContext, StoredObject } from '../types';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const SUFFIX: Record<string, string> = { XASX: '.AX', XLON: '.L', XAMS: '.AS', XNAS: '', XNYS: '' };

export function yahooSymbol(h: Holding): string {
  if (h.yahoo) return h.yahoo;
  const suffix = SUFFIX[h.exchange];
  if (suffix === undefined) throw new Error(`prices: no Yahoo suffix known for exchange ${h.exchange} (${h.ticker}); set "yahoo" on the holding`);
  return `${h.ticker}${suffix}`;
}

export function chartUrl(symbol: string, now: Date): string {
  const period2 = Math.floor(now.getTime() / 1000) + 86_400;
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=0&period2=${period2}&interval=1d&events=div%2Csplit`;
}

interface ChartJson {
  chart?: {
    result?: {
      meta?: { currency?: string; symbol?: string; exchangeName?: string; fullExchangeName?: string; exchangeTimezoneName?: string; instrumentType?: string; longName?: string; shortName?: string; firstTradeDate?: number | null };
      timestamp?: number[];
      indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[]; adjclose?: { adjclose?: (number | null)[] }[] };
      events?: { dividends?: Record<string, { amount: number; date: number }>; splits?: Record<string, { numerator: number; denominator: number; splitRatio: string; date: number }> };
    }[];
    error?: { code?: string; description?: string } | null;
  };
}

export interface PriceSeries {
  symbol: string;
  currency?: string;
  exchange?: string;
  timezone: string;
  name?: string;
  rows: { date: string; open: number | null; high: number | null; low: number | null; close: number | null; adjclose: number | null; volume: number | null; dividend: number | null; split: string | null }[];
}

function localDate(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts * 1000));
}

/** Parse the chart JSON into dated rows. Throws when Yahoo reports an error. */
export function parseChart(json: unknown, symbol: string): PriceSeries {
  const c = (json as ChartJson).chart;
  if (!c) throw new Error(`prices: unexpected response for ${symbol}`);
  if (c.error) throw new Error(`prices: Yahoo error for ${symbol}: ${c.error.code ?? ''} ${c.error.description ?? ''}`.trim());
  const r = c.result?.[0];
  if (!r) throw new Error(`prices: no result for ${symbol}`);
  const tz = r.meta?.exchangeTimezoneName || 'UTC';
  const ts = r.timestamp ?? [];
  const q = r.indicators?.quote?.[0] ?? {};
  const adj = r.indicators?.adjclose?.[0]?.adjclose ?? [];
  const divByDate = new Map<string, number>();
  for (const d of Object.values(r.events?.dividends ?? {})) divByDate.set(localDate(d.date, tz), (divByDate.get(localDate(d.date, tz)) ?? 0) + d.amount);
  const splitByDate = new Map<string, string>();
  for (const s of Object.values(r.events?.splits ?? {})) splitByDate.set(localDate(s.date, tz), `${s.numerator}:${s.denominator}`);
  const rows: PriceSeries['rows'] = [];
  for (let i = 0; i < ts.length; i++) {
    const date = localDate(ts[i], tz);
    const close = q.close?.[i] ?? null;
    if (close === null && (q.open?.[i] ?? null) === null) continue; // Yahoo pads with empty bars
    rows.push({
      date,
      open: q.open?.[i] ?? null,
      high: q.high?.[i] ?? null,
      low: q.low?.[i] ?? null,
      close,
      adjclose: adj[i] ?? null,
      volume: q.volume?.[i] ?? null,
      dividend: divByDate.get(date) ?? null,
      split: splitByDate.get(date) ?? null,
    });
  }
  return { symbol, currency: r.meta?.currency, exchange: r.meta?.fullExchangeName || r.meta?.exchangeName, timezone: tz, name: r.meta?.longName || r.meta?.shortName, rows };
}

const fmt = (v: number | null): string => (v === null || v === undefined ? '' : Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6));

export function toCsv(series: PriceSeries): string {
  const lines = ['date,open,high,low,close,adjclose,volume,dividend,split'];
  for (const r of series.rows) lines.push([r.date, fmt(r.open), fmt(r.high), fmt(r.low), fmt(r.close), fmt(r.adjclose), fmt(r.volume), fmt(r.dividend), r.split ?? ''].join(','));
  return lines.join('\n') + '\n';
}

export const pricesSource: Source = {
  id: 'prices',
  minDelayMs: 500,
  concurrency: 2,

  // One "filing" per holding per calendar day: the refreshed full history.
  async list(holding: Holding, _mode: ListMode, _cursor: string | undefined, ctx: SourceContext): Promise<ListPage> {
    const symbol = yahooSymbol(holding);
    const today = ctx.now().toISOString().slice(0, 10);
    return {
      refs: [
        {
          source: 'prices',
          ticker: holding.ticker,
          id: `refresh-${today}`,
          date: today,
          title: `Daily price history ${symbol}`,
          form: 'prices',
          url: chartUrl(symbol, ctx.now()),
          extra: { symbol },
        },
      ],
    };
  },

  async download(ref: FilingRef, ctx: SourceContext): Promise<StoredObject[]> {
    const symbol = String(ref.extra?.symbol ?? ref.ticker);
    const res = await ctx.fetch(ref.url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } });
    if (res.status !== 200) throw new Error(`prices: ${symbol} -> HTTP ${res.status}`);
    const series = parseChart(await res.json(), symbol);
    const first = series.rows[0]?.date;
    const last = series.rows[series.rows.length - 1]?.date;
    const meta = {
      ...ref,
      symbol,
      currency: series.currency,
      exchange: series.exchange,
      timezone: series.timezone,
      name: series.name,
      bars: series.rows.length,
      firstDate: first,
      lastDate: last,
      csv: series.rows.length ? `prices/${ref.ticker}.csv` : undefined,
      source: 'Yahoo Finance chart API',
    };
    const out: StoredObject[] = [
      { key: `prices/${ref.ticker}.json`, body: JSON.stringify(meta, null, 2), contentType: 'application/json', meta },
    ];
    if (series.rows.length) out.push({ key: `prices/${ref.ticker}.csv`, body: toCsv(series), contentType: 'text/csv; charset=utf-8', meta });
    else console.warn(`prices: ${symbol} has no price history on Yahoo`);
    return out;
  },
};
