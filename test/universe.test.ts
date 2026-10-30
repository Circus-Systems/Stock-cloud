import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseVasHoldings, latestMonthlyXlsxUrl, parseMonthlyWorkbook, parseSpotlightSheet, parseDirectoryCsv, mergeUniverse, buildUniverse, VAS_HOLDINGS_URL, MONTHLY_REPORT_PAGE, DIRECTORY_CSV_URL } from '../src/universe';
import type { SourceContext } from '../src/types';

const fx = (n: string) => join(__dirname, 'fixtures', n);
const vas = JSON.parse(readFileSync(fx('vanguard_vas_holdings.json'), 'utf8'));
const page = readFileSync(fx('asx_monthly_report_page.html'), 'utf8');
const xlsx = readFileSync(fx('asx_investment_products.xlsx'));
const dirCsv = readFileSync(fx('asx_directory.csv'), 'utf8');

describe('universe sources', () => {
  it('reads the ASX 300 constituents from VAS holdings', () => {
    const { items, asOf } = parseVasHoldings(vas);
    expect(items.length).toBeGreaterThanOrEqual(290);
    expect(items.length).toBeLessThanOrEqual(320);
    expect(items.map((i) => i.code)).toContain('BHP');
    expect(items.map((i) => i.code)).toContain('CBA');
    expect(items.every((i) => i.tags.includes('asx300'))).toBe(true);
    expect(asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('picks the newest monthly spreadsheet on the report page', () => {
    expect(latestMonthlyXlsxUrl(page)).toBe('https://www.asx.com.au/content/dam/asx/issuers/asx-investment-products-reports/2026/excel/asx-investment-products-sep-2026-abs.xlsx');
    expect(latestMonthlyXlsxUrl('<a href="/x/asx-investment-products-reports/2025/excel/asx-investment-products-december-2025.xlsx">a</a><a href="/x/asx-investment-products-reports/2026/excel/asx-investment-products-jan-2026-abs.xlsx">b</a>')).toContain('jan-2026');
    expect(latestMonthlyXlsxUrl('<p>nothing</p>')).toBeUndefined();
  });

  it('parses the ETP, LIC, A-REIT and infrastructure sheets', async () => {
    const items = await parseMonthlyWorkbook(xlsx.buffer.slice(xlsx.byteOffset, xlsx.byteOffset + xlsx.byteLength));
    const by = (t: string) => items.filter((i) => i.tags.includes(t));
    expect(by('etp').length).toBeGreaterThanOrEqual(450);
    expect(by('lic').length).toBeGreaterThanOrEqual(80);
    expect(by('areit').length).toBeGreaterThanOrEqual(35);
    expect(by('infra').length).toBeGreaterThanOrEqual(2);
    expect(by('etp').map((i) => i.code)).toContain('VAS');
    expect(by('lic').map((i) => i.code)).toContain('AFI');
    expect(items.some((i) => i.type === 'Index')).toBe(false);
    expect(items.some((i) => /XJO|XKO/.test(i.code))).toBe(false);
    const vasItem = by('etp').find((i) => i.code === 'VAS')!;
    expect(vasItem.name).toMatch(/Vanguard/i);
    expect(vasItem.section).toBe('Equity - Australia');
  });

  it('parseSpotlightSheet handles sections and skips index rows', () => {
    const rows = [[''], ['', 'ASX \nCode', 'Type', 'Issuer', 'Fund Name'], ['', 'Australian Indices'], ['', 'XJO', 'Index', '', 'S&P/ASX 200'], ['', 'Equity - Australia'], ['', 'A200', 'ETF', 'Betashares', 'Betashares Australia 200 ETF'], ['', 'VAS', 'ETF', 'Vanguard', 'Vanguard Australian Shares']];
    const items = parseSpotlightSheet(rows, 'etp');
    expect(items.map((i) => i.code)).toEqual(['A200', 'VAS']);
    expect(items[0]).toMatchObject({ name: 'Betashares Australia 200 ETF', section: 'Equity - Australia', type: 'ETF' });
  });

  it('parses the directory CSV', () => {
    const rows = parseDirectoryCsv(dirCsv);
    expect(rows.length).toBeGreaterThan(1500);
    const afi = rows.find((r) => r.code === 'AFI')!;
    expect(afi.gics).toBe('Not Applic');
    expect(afi.marketCap).toBeGreaterThan(1e9);
    expect(rows.find((r) => r.code === 'BHP')!.name).toMatch(/BHP/);
  });

  it('merges, tags, names, shards and excludes portfolio tickers', () => {
    const { holdings, counts } = mergeUniverse(
      [[{ code: 'BHP', name: 'BHP', tags: ['asx300'] }, { code: 'CBA', name: 'CBA', tags: ['asx300'] }], [{ code: 'AFI', name: 'AFI x', tags: ['lic'] }, { code: 'VAS', name: 'Vanguard', tags: ['etp'] }]],
      parseDirectoryCsv(dirCsv),
      new Set(['BHP', 'VAS']),
      6,
    );
    const by = Object.fromEntries(holdings.map((h) => [h.ticker, h]));
    expect(by.BHP).toBeUndefined();
    expect(by.VAS).toBeUndefined();
    expect(by.CBA.sources).toEqual(['asx', 'prices']);
    expect(by.CBA.name).toMatch(/COMMONWEALTH BANK/i);
    expect(by.AFI.universe).toEqual(expect.arrayContaining(['lic', 'fund']));
    expect(holdings.every((h) => h.shard! >= 0 && h.shard! < 6)).toBe(true);
    // every Not Applic / REIT directory entry is included as a fund
    expect(counts.fund).toBeGreaterThan(100);
    expect(holdings.length).toBeGreaterThan(100);
  });

  it('buildUniverse wires the three sources together', async () => {
    const ctx: SourceContext = {
      now: () => new Date('2026-10-31T00:00:00Z'),
      fetch: async (u) => {
        if (u === VAS_HOLDINGS_URL) return new Response(JSON.stringify(vas));
        if (u === MONTHLY_REPORT_PAGE) return new Response(page);
        if (u.endsWith('.xlsx')) return new Response(xlsx);
        if (u === DIRECTORY_CSV_URL) return new Response(dirCsv);
        return new Response('nope', { status: 404 });
      },
    };
    const doc = await buildUniverse(ctx, new Set(['BHP', 'VAS', 'AFI']));
    expect(doc.counts.asx300).toBeGreaterThanOrEqual(290);
    expect(doc.counts.etp).toBeGreaterThanOrEqual(450);
    expect(doc.counts.total).toBeGreaterThan(800);
    expect(doc.counts.total).toBeLessThan(1200);
    expect(doc.holdings.some((h) => h.ticker === 'BHP')).toBe(false);
    expect(doc.sources.xlsxUrl).toContain('sep-2026');
    expect(new Set(doc.holdings.map((h) => h.ticker)).size).toBe(doc.holdings.length);
    console.log('universe counts', doc.counts);
  });
});
