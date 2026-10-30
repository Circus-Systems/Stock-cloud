import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adyenSource, assetIdFromUrl, parseDocumentLinks, parseFinancialsTables } from '../src/sources/adyen';
import type { Fetcher, FilingRef, Holding, SourceContext } from '../src/types';
import { sha1Hex } from '../src/util';

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const FIN_URL = 'https://investors.adyen.com/financials';
const GM_URL = 'https://investors.adyen.com/general-meetings';
const H1_URL = 'https://investors.adyen.com/financials/h1-2026-c2a1a';

const holding: Holding = { ticker: 'ADYEN', exchange: 'XAMS', sources: ['adyen'] };

/** Fetch stub: the three fixture pages return 200, every other URL returns 404. */
function fixtureFetch(extra: Record<string, () => Response> = {}): Fetcher {
  const pages: Record<string, string> = {
    [FIN_URL]: fixture('adyen_financials.html'),
    [GM_URL]: fixture('adyen_general_meetings.html'),
    [H1_URL]: fixture('adyen_subpage.html'),
  };
  return async (url: string) => {
    if (extra[url]) return extra[url]();
    const html = pages[url];
    if (html !== undefined) {
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return new Response('not found', { status: 404 });
  };
}

function ctxWith(fetch: Fetcher): SourceContext {
  return { fetch, now: () => new Date('2026-10-30T12:00:00Z') };
}

const FIRST_ASSET_RE = /https:\/\/brand\.adyen\.com\/api\/asset\/[^"]+\/download/;

describe('parseFinancialsTables', () => {
  const entries = parseFinancialsTables(fixture('adyen_financials.html'));

  it('returns at least 20 entries', () => {
    expect(entries.length).toBeGreaterThanOrEqual(20);
  });

  it('contains the H1 2026 shareholder letter entry', () => {
    expect(entries).toContainEqual({
      table: expect.stringContaining('Half-year'),
      row: 'Shareholder letter and interim financial statements',
      year: '2026',
      period: 'H1',
      href: 'https://investors.adyen.com/financials/h1-2026-c2a1a',
    });
  });

  it('returns brand.adyen.com asset entries', () => {
    expect(entries.some((e) => e.href.startsWith('https://brand.adyen.com'))).toBe(true);
  });

  it('gives every entry a four-digit year', () => {
    for (const e of entries) expect(e.year).toMatch(/^\d{4}$/);
  });

  it('parses the general meetings tables', () => {
    const gm = parseFinancialsTables(fixture('adyen_general_meetings.html'));
    expect(gm.some((e) => e.table === 'Annual General Meetings' && e.row === 'Convening notice')).toBe(true);
  });
});

describe('parseDocumentLinks', () => {
  it('finds brand.adyen.com assets with asset- ids on a sub-page', () => {
    const docs = parseDocumentLinks(fixture('adyen_subpage.html'), H1_URL);
    const assets = docs.filter((d) => d.url.startsWith('https://brand.adyen.com') && d.id.startsWith('asset-'));
    expect(assets.length).toBeGreaterThanOrEqual(1);
  });

  it('finds at least 10 documents on the general meetings page', () => {
    const docs = parseDocumentLinks(fixture('adyen_general_meetings.html'), GM_URL);
    expect(docs.length).toBeGreaterThanOrEqual(10);
  });

  it('finds the adyen.com DAM press release PDF on the financials page', () => {
    const docs = parseDocumentLinks(fixture('adyen_financials.html'), FIN_URL);
    const dam = docs.find((d) => d.url.startsWith('https://www.adyen.com/dam/'));
    expect(dam?.id).toMatch(/^dam-[0-9a-f-]+$/);
  });

  it('ignores press-and-media article pages and mailto links', () => {
    const docs = parseDocumentLinks(fixture('adyen_financials.html'), FIN_URL);
    expect(docs.some((d) => d.url.includes('/press-and-media/'))).toBe(false);
    expect(docs.some((d) => d.url.startsWith('mailto:'))).toBe(false);
  });

  it('uses the first 16 hex chars of sha1 for plain file links', async () => {
    const url = 'https://example.com/reports/Annual-Report.XHTML';
    const html = `<a href="${url}">Annual report</a>`;
    const [doc] = parseDocumentLinks(html, FIN_URL);
    expect(doc.url).toBe(url);
    expect(doc.id).toBe((await sha1Hex(url)).slice(0, 16));
  });

  it('resolves relative document hrefs against the page URL', () => {
    const html = '<a href="/dam/jcr:0c1f2e3d-0000-4000-8000-000000000001/notice.pdf">Notice</a>';
    const [doc] = parseDocumentLinks(html, FIN_URL);
    expect(doc.url).toBe('https://investors.adyen.com/dam/jcr:0c1f2e3d-0000-4000-8000-000000000001/notice.pdf');
    expect(doc.id).toBe('dam-0c1f2e3d-0000-4000-8000-000000000001');
  });
});

describe('assetIdFromUrl', () => {
  it('decodes the numeric id of a real asset URL from the fixtures', () => {
    const url = fixture('adyen_financials.html').match(FIRST_ASSET_RE)![0];
    const token = url.split('/api/asset/')[1].split(':')[0];
    const json = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as { id: number };
    expect(assetIdFromUrl(url)).toBe(`asset-${json.id}`);
    expect(assetIdFromUrl(url)).toMatch(/^asset-\d+$/);
  });

  it('returns undefined for non-asset URLs', () => {
    expect(assetIdFromUrl('https://www.adyen.com/dam/jcr:abc/x.pdf')).toBeUndefined();
  });
});

describe('list', () => {
  it('returns at least 40 unique refs from the fixtures with no further cursor', async () => {
    const page = await adyenSource.list(holding, 'full', undefined, ctxWith(fixtureFetch()));
    expect(page.nextCursor).toBeUndefined();
    expect(page.refs.length).toBeGreaterThanOrEqual(40);
    const ids = page.refs.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of page.refs) {
      expect(r.source).toBe('adyen');
      expect(r.ticker).toBe('ADYEN');
      expect(r.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('titles table documents from row, period and year', async () => {
    const page = await adyenSource.list(holding, 'full', undefined, ctxWith(fixtureFetch()));
    const h1 = page.refs.find((r) => r.url.startsWith('https://brand.adyen.com') && r.title.startsWith('Shareholder letter and interim financial statements H1 2026'));
    expect(h1).toBeDefined();
    expect(h1!.date).toBe('2026-06-30');
  });

  it('titles sub-page documents with the sub-page title and derives a year', async () => {
    const page = await adyenSource.list(holding, 'full', undefined, ctxWith(fixtureFetch()));
    const sub = page.refs.find((r) => r.extra?.pageUrl === H1_URL);
    expect(sub).toBeDefined();
    expect(sub!.title).toBe('Shareholder letter H1 2026 – H1 2026 Shareholder Letter');
    expect(sub!.date).toBe('2026-01-01');
  });

  it('throws when a hub page fails', async () => {
    const fetch: Fetcher = async () => new Response('down', { status: 503 });
    await expect(adyenSource.list(holding, 'full', undefined, ctxWith(fetch))).rejects.toThrow();
  });
});

describe('download', () => {
  const pdfRef: FilingRef = {
    source: 'adyen',
    ticker: 'ADYEN',
    id: 'asset-146118',
    date: '2026-06-30',
    title: 'Shareholder letter and interim financial statements H1 2026',
    url: 'https://brand.adyen.com/api/asset/eyJpZCI6MTQ2MTE4fQ:adyen:sig/download',
  };

  it('stores the body under the expected key with a pdf extension', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer;
    const fetch = fixtureFetch({
      [pdfRef.url]: () =>
        new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } }),
    });
    const [obj] = await adyenSource.download(pdfRef, ctxWith(fetch));
    expect(obj.key).toMatch(/^adyen\/ADYEN\/\d{4}\/[a-z0-9-]+_asset-\d+\.pdf$/);
    expect(obj.key).toBe('adyen/ADYEN/2026/shareholder-letter-and-interim-financial-statements-h1-2026_asset-146118.pdf');
    expect(obj.contentType).toBe('application/pdf');
    expect(obj.body).toBeInstanceOf(ArrayBuffer);
    expect(obj.meta).toMatchObject({ id: 'asset-146118', contentType: 'application/pdf' });
  });

  it('uses the content-disposition extension for brand assets sent as octet-stream', async () => {
    const fetch = fixtureFetch({
      [pdfRef.url]: () =>
        new Response('x', {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="letter.xlsx"',
          },
        }),
    });
    const [obj] = await adyenSource.download(pdfRef, ctxWith(fetch));
    expect(obj.key.endsWith('_asset-146118.xlsx')).toBe(true);
  });

  it('throws on a non-200 response', async () => {
    const fetch = fixtureFetch({ [pdfRef.url]: () => new Response('nope', { status: 404 }) });
    await expect(adyenSource.download(pdfRef, ctxWith(fetch))).rejects.toThrow();
  });
});
