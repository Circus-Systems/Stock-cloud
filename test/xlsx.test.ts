import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readXlsx } from '../src/xlsx';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'asx_investment_products.xlsx');
const bytes = (): Uint8Array => readFileSync(FIXTURE);

/** Collapse whitespace (including the newline in "ASX \nCode") for header matching. */
const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

describe('readXlsx', () => {
  it('lists every sheet in workbook order', async () => {
    const wb = await readXlsx(bytes());
    // The fixture's workbook.xml declares 16 sheets (the brief said 15; 16 is what the file contains).
    expect(wb.sheetNames).toHaveLength(16);
    expect(wb.sheetNames.slice(0, 4)).toEqual([
      'Spotlight ETPs',
      'Spotlight ETPs Issuers',
      'Spotlight ETP List',
      'Spotlight LIC List',
    ]);
  });

  it('accepts an ArrayBuffer as well as a Uint8Array', async () => {
    const u8 = bytes();
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
    const wb = await readXlsx(ab);
    expect(wb.sheetNames).toHaveLength(16);
    expect(wb.sheetNames[2]).toBe('Spotlight ETP List');
  });

  it('rejects for a sheet that does not exist', async () => {
    const wb = await readXlsx(bytes());
    await expect(wb.sheet('nope')).rejects.toThrow(/nope/);
  });

  it('rejects input that is not a ZIP archive', async () => {
    await expect(readXlsx(new TextEncoder().encode('not a workbook'))).rejects.toThrow();
  });
});

describe('ETP list sheet', () => {
  it('parses at least 500 rows within 3 seconds', async () => {
    const wb = await readXlsx(bytes());
    const start = performance.now();
    const rows = await wb.sheet('Spotlight ETP List');
    const elapsed = performance.now() - start;
    expect(rows.length).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeLessThan(3000);
  });

  it('has the ASX Code / Type / Issuer / Fund Name header in columns B to E', async () => {
    const rows = await (await readXlsx(bytes())).sheet('Spotlight ETP List');
    const header = rows.find(
      (r) =>
        r[1] !== undefined &&
        squash(r[1]) === 'ASX Code' &&
        r[2] === 'Type' &&
        r[3] === 'Issuer' &&
        r[4] === 'Fund Name',
    );
    expect(header).toBeDefined();
  });

  it('has the A200 row with ETF type and Betashares issuer', async () => {
    const rows = await (await readXlsx(bytes())).sheet('Spotlight ETP List');
    const a200 = rows.find((r) => r[1] === 'A200');
    expect(a200).toBeDefined();
    expect(a200![2]).toBe('ETF');
    expect(a200![3]).toBe('Betashares');
  });

  it('returns numeric cells as their stored string (A200 MER = "0.04")', async () => {
    const rows = await (await readXlsx(bytes())).sheet('Spotlight ETP List');
    const a200 = rows.find((r) => r[1] === 'A200')!;
    // Column H (index 7) holds the MER (% p.a.) column.
    expect(a200[7]).toBe('0.04');
  });
});

describe('LIC list sheet', () => {
  it('has an AFI row with Shares in column B and a market cap above 1000', async () => {
    const rows = await (await readXlsx(bytes())).sheet('Spotlight LIC List');
    const afi = rows.find((r) => r[0] === 'AFI' && r[1] === 'Shares');
    expect(afi).toBeDefined();
    const caps = afi!
      .map((v) => Number(v.replace(/,/g, '')))
      .filter((n) => Number.isFinite(n));
    expect(caps.some((n) => n > 1000)).toBe(true);
  });
});
