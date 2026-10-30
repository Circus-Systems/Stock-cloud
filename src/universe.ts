/**
 * Automatic ASX universe: the S&P/ASX 300 plus every listed ETP, LIC/LIT, A-REIT
 * and infrastructure fund. Rebuilt from three public sources:
 *   1. Vanguard's VAS (ASX 300 index ETF) holdings API → the 300 constituents.
 *   2. The ASX "investment products monthly report" spreadsheet → ETP, LIC, A-REIT, infra lists.
 *   3. The ASX company directory CSV → names, plus funds/REITs by GICS.
 * The result is stored at _universe/universe.json in R2 and merged with holdings.json
 * on every run; new codes are backfilled automatically ('auto' sync mode).
 */
import type { Holding, SourceContext } from './types';
import { decodeEntities } from './util';
import { readXlsx } from './xlsx';
import { hashShard, shardCount } from './sync';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
export const VAS_HOLDINGS_URL = 'https://www.vanguard.com.au/personal/api/data/products/holdings-download/8205';
export const MONTHLY_REPORT_PAGE = 'https://www.asx.com.au/issuers/investment-products/asx-investment-products-monthly-report';
export const DIRECTORY_CSV_URL = 'https://asx.api.markitdigital.com/asx-research/1.0/companies/directory/file';

const CODE_RE = /^[A-Z0-9]{3,6}$/;

export interface UniverseItem {
  code: string;
  name: string;
  tags: string[];
  type?: string;
  section?: string;
}

export interface UniverseDoc {
  generatedAt: string;
  sources: { vasAsOf?: string; xlsxUrl?: string; directoryRows?: number };
  counts: Record<string, number>;
  holdings: Holding[];
}

/** ASX 300 constituents from VAS holdings (tickers of Australian equities). */
export function parseVasHoldings(json: unknown): { items: UniverseItem[]; asOf?: string } {
  const data = (json as { data?: unknown }).data;
  const list = (Array.isArray(data) ? data : (data as { items?: unknown[] } | undefined)?.items ?? []) as { ticker?: string; name?: string; longName?: string; countryCode?: string; effectiveDate?: string }[];
  const items: UniverseItem[] = [];
  let asOf: string | undefined;
  for (const h of list) {
    const code = (h.ticker ?? '').trim().toUpperCase();
    if (!CODE_RE.test(code)) continue;
    if (h.countryCode && h.countryCode !== 'AU') continue;
    items.push({ code, name: h.longName || h.name || code, tags: ['asx300'] });
    asOf = asOf ?? h.effectiveDate;
  }
  return { items, asOf };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Latest monthly spreadsheet link on the ASX report page. */
export function latestMonthlyXlsxUrl(html: string): string | undefined {
  const links = [...html.matchAll(/href="([^"]*asx-investment-products-reports\/(\d{4})\/excel\/[^"]*?([a-z]{3})[a-z]*-(\d{4})[^"]*\.xlsx)"/gi)];
  let best: { url: string; key: number } | undefined;
  for (const m of links) {
    const month = MONTHS.indexOf(m[3].toLowerCase());
    if (month < 0) continue;
    const key = parseInt(m[4], 10) * 100 + month;
    if (!best || key > best.key) best = { url: new URL(decodeEntities(m[1]), 'https://www.asx.com.au').toString(), key };
  }
  return best?.url;
}

const norm = (c: string | undefined): string => (c ?? '').replace(/\s+/g, ' ').trim();

/**
 * Parse one "Spotlight … List" sheet: a header row containing "ASX Code", then
 * section rows (a label in the code column with no Type) and item rows.
 * Index reference rows (Type "Index") are excluded.
 */
export function parseSpotlightSheet(rows: string[][], tag: string): UniverseItem[] {
  const hdrIdx = rows.findIndex((r) => r.some((c) => norm(c) === 'ASX Code'));
  if (hdrIdx < 0) throw new Error(`universe: sheet for ${tag} has no "ASX Code" header`);
  const hdr = rows[hdrIdx].map(norm);
  const ci = hdr.indexOf('ASX Code');
  const ti = hdr.findIndex((c) => /^Type\*?$/.test(c));
  const ni = hdr.indexOf('Fund Name');
  const items: UniverseItem[] = [];
  let section: string | undefined;
  for (const r of rows.slice(hdrIdx + 1)) {
    const code = norm(r[ci]);
    const type = ti >= 0 ? norm(r[ti]) : '';
    if (!code) continue;
    if (CODE_RE.test(code) && (ti < 0 || type)) {
      if (/^index$/i.test(type) || /indices/i.test(section ?? '')) continue;
      items.push({ code, name: ni >= 0 ? norm(r[ni]) || code : code, tags: [tag], type, section });
    } else if (!CODE_RE.test(code)) {
      section = code;
    }
  }
  return items;
}

export const SPOTLIGHT_SHEETS: { name: string; tag: string }[] = [
  { name: 'Spotlight ETP List', tag: 'etp' },
  { name: 'Spotlight LIC List', tag: 'lic' },
  { name: 'Spotlight A-REITS  List', tag: 'areit' },
  { name: 'Spotlight Infra  List', tag: 'infra' },
];

/** Resolve the sheet by exact name, else by collapsed-whitespace, case-insensitive match. */
function findSheet(names: string[], wanted: string): string | undefined {
  if (names.includes(wanted)) return wanted;
  const w = norm(wanted).toLowerCase();
  return names.find((n) => norm(n).toLowerCase() === w);
}

export async function parseMonthlyWorkbook(data: ArrayBuffer): Promise<UniverseItem[]> {
  const wb = await readXlsx(data);
  const out: UniverseItem[] = [];
  for (const { name, tag } of SPOTLIGHT_SHEETS) {
    const sheet = findSheet(wb.sheetNames, name);
    if (!sheet) {
      console.warn(`universe: sheet "${name}" not found (have ${wb.sheetNames.join(', ')})`);
      continue;
    }
    out.push(...parseSpotlightSheet(await wb.sheet(sheet), tag));
  }
  return out;
}

/** The ASX directory CSV: "ASX code","Company name","GICs industry group","Listing date","Market Cap". */
export function parseDirectoryCsv(csv: string): { code: string; name: string; gics: string; marketCap: number }[] {
  const out: { code: string; name: string; gics: string; marketCap: number }[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const cells = [...line.matchAll(/"((?:[^"]|"")*)"|([^,]+)/g)].map((m) => (m[1] ?? m[2] ?? '').replace(/""/g, '"').trim());
    if (cells.length < 3 || !CODE_RE.test(cells[0]) || cells[0] === 'ASX') continue;
    out.push({ code: cells[0], name: cells[1], gics: cells[2], marketCap: Number(cells[4] ?? 0) || 0 });
  }
  return out;
}

export function mergeUniverse(groups: UniverseItem[][], directory: ReturnType<typeof parseDirectoryCsv>, exclude: Set<string>, shards: number): { holdings: Holding[]; counts: Record<string, number> } {
  const byCode = new Map<string, UniverseItem>();
  const counts: Record<string, number> = {};
  const add = (it: UniverseItem) => {
    for (const t of it.tags) counts[t] = (counts[t] ?? 0) + 1;
    const cur = byCode.get(it.code);
    if (cur) {
      for (const t of it.tags) if (!cur.tags.includes(t)) cur.tags.push(t);
      if (!cur.name || cur.name === cur.code) cur.name = it.name;
    } else byCode.set(it.code, { ...it, tags: [...it.tags] });
  };
  for (const g of groups) for (const it of g) add(it);
  const dirByCode = new Map(directory.map((d) => [d.code, d]));
  for (const d of directory) {
    if (d.gics === 'Not Applic' || /REIT/i.test(d.gics)) add({ code: d.code, name: d.name, tags: ['fund'] });
  }
  const holdings: Holding[] = [];
  for (const it of [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code))) {
    if (exclude.has(it.code)) continue;
    const d = dirByCode.get(it.code);
    holdings.push({
      ticker: it.code,
      exchange: 'XASX',
      name: d?.name || it.name,
      sources: ['asx', 'prices'],
      universe: it.tags,
      shard: hashShard(it.code, shards),
    });
  }
  counts.total = holdings.length;
  return { holdings, counts };
}

/** Fetch everything and build the universe document. Throws if a source is unavailable. */
export async function buildUniverse(ctx: SourceContext, exclude: Set<string>): Promise<UniverseDoc> {
  const headers = { 'user-agent': UA, accept: '*/*' };
  const vasRes = await ctx.fetch(VAS_HOLDINGS_URL, { headers });
  if (vasRes.status !== 200) throw new Error(`universe: VAS holdings HTTP ${vasRes.status}`);
  const vas = parseVasHoldings(await vasRes.json());
  if (vas.items.length < 200) throw new Error(`universe: VAS holdings returned only ${vas.items.length} tickers`);

  const pageRes = await ctx.fetch(MONTHLY_REPORT_PAGE, { headers: { ...headers, accept: 'text/html' } });
  if (pageRes.status !== 200) throw new Error(`universe: monthly report page HTTP ${pageRes.status}`);
  const xlsxUrl = latestMonthlyXlsxUrl(await pageRes.text());
  if (!xlsxUrl) throw new Error('universe: no monthly spreadsheet link found');
  const xlsxRes = await ctx.fetch(xlsxUrl, { headers });
  if (xlsxRes.status !== 200) throw new Error(`universe: spreadsheet HTTP ${xlsxRes.status}`);
  const products = await parseMonthlyWorkbook(await xlsxRes.arrayBuffer());
  if (products.length < 300) throw new Error(`universe: spreadsheet yielded only ${products.length} products`);

  const dirRes = await ctx.fetch(DIRECTORY_CSV_URL, { headers });
  if (dirRes.status !== 200) throw new Error(`universe: directory CSV HTTP ${dirRes.status}`);
  const directory = parseDirectoryCsv(await dirRes.text());
  if (directory.length < 1000) throw new Error(`universe: directory CSV yielded only ${directory.length} rows`);

  const { holdings, counts } = mergeUniverse([vas.items, products], directory, exclude, shardCount('asx'));
  return {
    generatedAt: ctx.now().toISOString(),
    sources: { vasAsOf: vas.asOf, xlsxUrl, directoryRows: directory.length },
    counts,
    holdings,
  };
}
