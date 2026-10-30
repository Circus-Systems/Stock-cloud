import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  adyenSource,
  assetIdFromUrl,
  parseDocumentLinks,
  parseFinancialsTables,
  parsePressPage,
  parsePressPayload,
} from '../src/sources/adyen';
import type { Fetcher, FilingRef, Holding, SourceContext } from '../src/types';
import { sha1Hex } from '../src/util';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const FIN_URL = 'https://investors.adyen.com/financials';
const GM_URL = 'https://investors.adyen.com/general-meetings';
const EVENTS_URL = 'https://investors.adyen.com/events';
const GOV_URL = 'https://investors.adyen.com/governance';
const H1_URL = 'https://investors.adyen.com/financials/h1-2026-c2a1a';
const PAYLOAD_URL = 'https://www.adyen.com/press-and-media/_payload.json';
const PRESS_URL = 'https://www.adyen.com/press-and-media/adyen-publishes-h1-2026-financial-results-3wjne';

const holding: Holding = { ticker: 'ADYEN', exchange: 'XAMS', sources: ['adyen'] };

const EMPTY_HUB = '<!doctype html><html><head><title>Adyen</title></head><body></body></html>';

/**
 * Fetch stub: the three fixture pages return 200, the events and governance hubs return an empty 200 page
 * (they have no fixtures), every other URL returns 404.
 */
function fixtureFetch(extra: Record<string, () => Response> = {}): Fetcher {
  const pages: Record<string, string> = {
    [FIN_URL]: fixture('adyen_financials.html'),
    [GM_URL]: fixture('adyen_general_meetings.html'),
    [H1_URL]: fixture('adyen_subpage.html'),
    [EVENTS_URL]: EMPTY_HUB,
    [GOV_URL]: EMPTY_HUB,
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
    const h1 = page.refs.find((r) => r.title === 'Financial comparison H1 2026');
    expect(h1).toBeDefined();
    expect(h1!.url.startsWith('https://brand.adyen.com')).toBe(true);
    expect(h1!.date).toBe('2026-06-30');
    expect(h1!.extra).toMatchObject({ table: 'Half-year results', row: 'Financial comparison', period: 'H1', year: '2026' });
  });

  it('does not repeat the year when the table period is the year itself', async () => {
    const page = await adyenSource.list(holding, 'full', undefined, ctxWith(fixtureFetch()));
    expect(page.refs.some((r) => r.title === 'Convening notice 2026')).toBe(true);
  });

  it('uses the track title for stacked-list "Download PDF" links outside the tables', async () => {
    const page = await adyenSource.list(holding, 'full', undefined, ctxWith(fixtureFetch()));
    const rating = page.refs.find((r) => r.id === 'asset-146118');
    expect(rating?.title).toBe('Investors - Adyen S&P Global rating (14-09-2026)');
    expect(rating?.date).toBe('2026-01-01');
    expect(rating?.extra?.dateUnknown).toBeUndefined();
    const ethics = page.refs.find((r) => r.title === 'The Adyen way of building an ethical business');
    expect(ethics).toBeDefined();
    expect(ethics!.extra?.dateUnknown).toBe(true);
    expect(ethics!.date).toBe('2026-10-30');
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
    expect(obj.body).toBeInstanceOf(ReadableStream);
    const streamed = await new Response(obj.body as ReadableStream).arrayBuffer();
    expect(streamed.byteLength).toBeGreaterThan(0);
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

const payloadResponse = (): Response =>
  new Response(fixture('adyen_press_payload.json'), { status: 200, headers: { 'content-type': 'application/json' } });

const pageResponse = (html: string = fixture('adyen_press_release.html')): Response =>
  new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

describe('parsePressPayload', () => {
  const items = parsePressPayload(JSON.parse(fixture('adyen_press_payload.json')));

  it('returns at least 400 releases with unique slugs', () => {
    expect(items.length).toBeGreaterThanOrEqual(400);
    expect(new Set(items.map((i) => i.slug)).size).toBe(items.length);
  });

  it('resolves the index references of a release', () => {
    expect(items).toContainEqual(
      expect.objectContaining({
        id: '6r9VZ0uZ15v8AB0Xlp7FkG',
        slug: 'adyen-publishes-q3-2026-business-update-6r9vz0',
        title: 'Adyen publishes Q3 2026 Business Update',
        description: 'Adyen delivers strong execution and net revenue growth',
        firstPublishedAt: '2026-10-28T06:30:01.430Z',
      }),
    );
  });

  it('gives every release a slug, id and first publication date', () => {
    for (const i of items) {
      expect(i.slug).toMatch(/^[a-z0-9-]+$/);
      expect(i.id).not.toBe('');
      expect(i.firstPublishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('returns an empty title as an empty string (some CMS entries have none)', () => {
    expect(items.every((i) => typeof i.title === 'string')).toBe(true);
  });

  it('returns nothing for input that is not a payload array', () => {
    expect(parsePressPayload({ data: 1 })).toEqual([]);
    expect(parsePressPayload(null)).toEqual([]);
  });
});

describe('parsePressPage', () => {
  const page = parsePressPage(fixture('adyen_press_release.html'), PRESS_URL);

  it('takes the title without the " - Adyen" suffix', () => {
    expect(page.title).toBe('Adyen publishes H1 2026 financial results');
  });

  it('reads the first long-form date in the main content', () => {
    expect(page.date).toBe('2026-08-13');
  });

  it('keeps the main content without scripts or styles', () => {
    expect(page.contentHtml).toContain('today announces financial results');
    expect(page.contentHtml).not.toContain('<script');
    expect(page.contentHtml).not.toContain('<style');
  });

  it('lists the brand.adyen.com assets linked from the content', () => {
    expect(page.assets.some((a) => a.url.startsWith('https://brand.adyen.com') && a.id.startsWith('asset-'))).toBe(true);
  });

  it('reads the three date forms and ignores impossible dates', () => {
    const dateOf = (text: string): string | undefined => parsePressPage(`<main><p>${text}</p></main>`, PRESS_URL).date;
    expect(dateOf('August 13th, 2026')).toBe('2026-08-13');
    expect(dateOf('August 13, 2026')).toBe('2026-08-13');
    expect(dateOf('13 August 2026')).toBe('2026-08-13');
    expect(dateOf('February 30, 2026')).toBeUndefined();
    expect(dateOf('no date here')).toBeUndefined();
  });
});

describe('list with press releases', () => {
  it('appends one press ref per release after the hub refs', async () => {
    const base = await adyenSource.list(holding, 'full', undefined, ctxWith(fixtureFetch()));
    const page = await adyenSource.list(
      holding,
      'full',
      undefined,
      ctxWith(fixtureFetch({ [PAYLOAD_URL]: payloadResponse })),
    );
    expect(page.refs.slice(0, base.refs.length)).toEqual(base.refs);
    const press = page.refs.slice(base.refs.length);
    expect(press.length).toBeGreaterThanOrEqual(400);
    expect(press.every((r) => r.id.startsWith('pr-') && r.form === 'Press release')).toBe(true);
    const ids = page.refs.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('maps a release to its url, first publication date and extras', async () => {
    const page = await adyenSource.list(
      holding,
      'full',
      undefined,
      ctxWith(fixtureFetch({ [PAYLOAD_URL]: payloadResponse })),
    );
    const q3 = page.refs.find((r) => r.id === 'pr-adyen-publishes-q3-2026-business-update-6r9vz0');
    expect(q3).toMatchObject({
      source: 'adyen',
      ticker: 'ADYEN',
      date: '2026-10-28',
      title: 'Adyen publishes Q3 2026 Business Update',
      form: 'Press release',
      url: 'https://www.adyen.com/press-and-media/adyen-publishes-q3-2026-business-update-6r9vz0',
      extra: { kind: 'press-release', contentfulId: '6r9VZ0uZ15v8AB0Xlp7FkG', provisionalDate: true },
    });
  });

  it('keeps the hub refs and warns when the payload returns 500', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const base = await adyenSource.list(holding, 'full', undefined, ctxWith(fixtureFetch()));
      const page = await adyenSource.list(
        holding,
        'full',
        undefined,
        ctxWith(fixtureFetch({ [PAYLOAD_URL]: () => new Response('boom', { status: 500 }) })),
      );
      expect(page.refs).toEqual(base.refs);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('requests the events and governance hubs', async () => {
    const base = fixtureFetch();
    const requested: string[] = [];
    await adyenSource.list(
      holding,
      'full',
      undefined,
      ctxWith(async (url, init) => {
        requested.push(url);
        return base(url, init);
      }),
    );
    expect(requested).toEqual(expect.arrayContaining([EVENTS_URL, GOV_URL]));
  });

  it('throws when the events hub fails', async () => {
    const fetch = fixtureFetch({ [EVENTS_URL]: () => new Response('down', { status: 503 }) });
    await expect(adyenSource.list(holding, 'full', undefined, ctxWith(fetch))).rejects.toThrow();
  });
});

describe('download press release', () => {
  const pressRef: FilingRef = {
    source: 'adyen',
    ticker: 'ADYEN',
    id: 'pr-adyen-publishes-h1-2026-financial-results-3wjne',
    date: '2026-01-01',
    title: 'Adyen publishes H1 2026 financial results',
    form: 'Press release',
    url: PRESS_URL,
    extra: { kind: 'press-release', provisionalDate: true, pageUrl: PRESS_URL },
  };
  const STEM = 'adyen/ADYEN/2026/2026-08-13_pr_adyen-publishes-h1-2026-financial-results';
  const assetUrl = parsePressPage(fixture('adyen_press_release.html'), PRESS_URL).assets.find((a) =>
    a.url.startsWith('https://brand.adyen.com'),
  )!.url;

  it('stores the page as html under its page date, then each linked document', async () => {
    const fetch = fixtureFetch({
      [PRESS_URL]: () => pageResponse(),
      [assetUrl]: () =>
        new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer, {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        }),
    });
    const objs = await adyenSource.download(pressRef, ctxWith(fetch));
    expect(objs).toHaveLength(2);
    const [html, pdf] = objs;
    expect(html.key).toBe(`${STEM}.html`);
    expect(html.contentType).toBe('text/html; charset=utf-8');
    expect(html.meta).toMatchObject({
      date: '2026-08-13',
      provisionalDate: false,
      title: 'Adyen publishes H1 2026 financial results',
      pageUrl: PRESS_URL,
    });
    expect(html.body as string).toContain('<title>Adyen publishes H1 2026 financial results</title>');
    expect(pdf.key.startsWith(`${STEM}_asset-`)).toBe(true);
    expect(pdf.key.endsWith('.pdf')).toBe(true);
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.meta).toMatchObject({ date: '2026-08-13', sourceUrl: assetUrl });
  });

  it('keeps the html when a linked document returns 404', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fetch = fixtureFetch({
        [PRESS_URL]: () => pageResponse(),
        [assetUrl]: () => new Response('nope', { status: 404 }),
      });
      const objs = await adyenSource.download(pressRef, ctxWith(fetch));
      expect(objs.map((o) => o.key)).toEqual([`${STEM}.html`]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to the listing date when the page has no date', async () => {
    const html = '<html><head><title>Plain - Adyen</title></head><body><main><p>No date.</p></main></body></html>';
    const fetch = fixtureFetch({ [PRESS_URL]: () => pageResponse(html) });
    const [obj] = await adyenSource.download(pressRef, ctxWith(fetch));
    expect(obj.key).toBe('adyen/ADYEN/2026/2026-01-01_pr_plain.html');
    expect(obj.meta).toMatchObject({ date: '2026-01-01', provisionalDate: true, title: 'Plain' });
  });

  it('throws when the release page is not 200', async () => {
    const fetch = fixtureFetch({ [PRESS_URL]: () => new Response('gone', { status: 404 }) });
    await expect(adyenSource.download(pressRef, ctxWith(fetch))).rejects.toThrow();
  });
});
