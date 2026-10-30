import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractStoryHtml, parseListing, rnsSource } from '../src/sources/rns';
import type { Fetcher, Holding, SourceContext } from '../src/types';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

const listingText = fixture('brighterir_listing.json');
const storyHtml = fixture('brighterir_story.html');

const holding: Holding = { ticker: 'RMV', exchange: 'XLON', sources: ['rns'], brighterir: 'rightmove_plc' };
const NOW = new Date('2026-10-30T12:00:00Z');

interface Call {
  url: string;
  init?: RequestInit;
}

/** Fetch stub that records every call and answers with `respond`. */
function stubFetch(respond: (url: string) => Response): { fetch: Fetcher; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: Fetcher = async (url, init) => {
    calls.push({ url, init });
    return respond(url);
  };
  return { fetch, calls };
}

function ctxWith(fetch: Fetcher): SourceContext {
  return { fetch, now: () => new Date(NOW) };
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const h = init?.headers as Record<string, string> | undefined;
  return h?.[name];
}

describe('parseListing', () => {
  const json = JSON.parse(listingText) as unknown;

  it('yields 100 refs and the server recordsTotal', () => {
    const { refs, recordsTotal } = parseListing(json, 'RMV');
    expect(refs).toHaveLength(100);
    expect(recordsTotal).toBe(3844);
  });

  it('maps the first row onto a FilingRef', () => {
    const [first] = parseListing(json, 'RMV').refs;
    expect(first.source).toBe('rns');
    expect(first.ticker).toBe('RMV');
    expect(first.id).toBe('xennvzx');
    expect(first.title).toBe('Transaction in Own Shares');
    expect(first.date).toBe('2023-09-21');
    expect(first.time).toBe('17:11');
    expect(first.form).toBe('PRN');
    expect(first.url).toMatch(/\/story\/xennvzx$/);
    expect(first.url.startsWith('https://polaris.brighterir.com/public/rightmove_plc/')).toBe(true);
    expect(first.extra?.pdfUrl).toMatch(/\/story\/xennvzx\/export$/);
    expect(first.extra?.listingId).toBe(203030);
    expect(first.extra?.provider).toBe('PRN');
    expect(first.extra?.regulatory).toBe(true);
  });

  it('gives every ref a unique id', () => {
    const { refs } = parseListing(json, 'RMV');
    expect(new Set(refs.map((r) => r.id)).size).toBe(100);
  });

  it('skips rows without a story link and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = {
      recordsTotal: 2,
      data: [
        { id: 1, headline: 'no link here', timestamp: '<time datetime="2024-01-02" class="formatted_date">02/01/2024</time>' },
        {
          id: 2,
          headline: '<a href="https://polaris.brighterir.com/public/rightmove_plc/news/html_rns_announcements/story/abc123">Half-year Report</a>',
          timestamp: '<time datetime="2024-01-03" class="formatted_date">03/01/2024</time>',
          provider: 'RNS',
          category: 'Results',
        },
      ],
    };
    const { refs } = parseListing(doc, 'RMV');
    expect(refs.map((r) => r.id)).toEqual(['abc123']);
    expect(refs[0].form).toBe('Results');
    expect(refs[0].time).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('throws on a payload without data or recordsTotal', () => {
    expect(() => parseListing({ recordsTotal: 1 }, 'RMV')).toThrow(/data/);
    expect(() => parseListing({ data: [] }, 'RMV')).toThrow(/recordsTotal/);
    expect(() => parseListing('<html></html>', 'RMV')).toThrow();
  });
});

describe('extractStoryHtml', () => {
  it('returns the xn-content markup, a title and the announcement date', () => {
    const story = extractStoryHtml(storyHtml, 'Transaction in Own Shares');
    expect(story.contentHtml.length).toBeGreaterThan(0);
    expect(story.contentHtml).toContain('Trading Update');
    expect(story.contentHtml).toContain('Rightmove plc');
    // Markup is preserved, not stripped.
    expect(story.contentHtml).toContain('<p style=');
    // The story fixture has no <title>, so the fallback is used.
    expect(story.title).toBe('Transaction in Own Shares');
    expect(story.date).toBe('2024-11-08');
  });

  it('returns an empty title when neither the page nor a fallback provides one', () => {
    expect(extractStoryHtml(storyHtml).title).toBe('');
  });

  it('prefers the page <title> and falls back to the whole body when xn-content is missing', () => {
    const html = '<html><head><title>Holding Announcement</title></head><body><p>Hello <b>world</b></p></body></html>';
    const story = extractStoryHtml(html, 'ignored');
    expect(story.title).toBe('Holding Announcement');
    expect(story.contentHtml).toBe('<p>Hello <b>world</b></p>');
  });

  it('balances nested divs inside xn-content', () => {
    const html =
      '<body><div class="xn-content"><div>a<div>b</div>c</div><p>tail</p></div><div>outside</div></body>';
    expect(extractStoryHtml(html).contentHtml).toBe('<div>a<div>b</div>c</div><p>tail</p>');
  });
});

describe('list', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('requests the listing with paging parameters and XHR headers', async () => {
    const { fetch, calls } = stubFetch(() => new Response(listingText, { status: 200 }));
    const page = await rnsSource.list(holding, 'full', undefined, ctxWith(fetch));

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toContain('start=0&length=100');
    expect(url).toContain('filter=all');
    expect(url).toContain('date_start=01-01-1990');
    expect(url).toContain('date_end=31-10-2026');
    expect(url.startsWith('https://polaris.brighterir.com/public/rightmove_plc/news/html_rns_announcements?')).toBe(true);
    expect(headerOf(init, 'x-requested-with')).toBe('XMLHttpRequest');
    expect(headerOf(init, 'accept')).toBe('application/json');

    expect(page.refs).toHaveLength(100);
    expect(page.nextCursor).toBe('100');
  });

  it('returns no next cursor once the offset passes recordsTotal', async () => {
    const { fetch, calls } = stubFetch(() => new Response(listingText, { status: 200 }));
    const page = await rnsSource.list(holding, 'full', '3800', ctxWith(fetch));
    expect(calls[0].url).toContain('start=3800&length=100');
    expect(page.nextCursor).toBeUndefined();
  });

  it('uses a 60-day window in recent mode', async () => {
    const { fetch, calls } = stubFetch(() => new Response(listingText, { status: 200 }));
    await rnsSource.list(holding, 'recent', undefined, ctxWith(fetch));
    expect(calls[0].url).toContain('date_start=31-08-2026');
    expect(calls[0].url).toContain('date_end=31-10-2026');
  });

  it('throws on a non-200 response', async () => {
    const { fetch } = stubFetch(() => new Response('busy', { status: 503 }));
    await expect(rnsSource.list(holding, 'full', undefined, ctxWith(fetch))).rejects.toThrow(/503/);
  });

  it('throws when the server returns the HTML shell instead of JSON', async () => {
    const { fetch } = stubFetch(() => new Response('<html><body>shell</body></html>', { status: 200 }));
    await expect(rnsSource.list(holding, 'full', undefined, ctxWith(fetch))).rejects.toThrow(/not JSON/);
  });

  it('throws a clear error when the holding has no brighterir slug', async () => {
    const { fetch } = stubFetch(() => new Response(listingText, { status: 200 }));
    const bare: Holding = { ticker: 'RMV', exchange: 'XLON', sources: ['rns'] };
    await expect(rnsSource.list(bare, 'full', undefined, ctxWith(fetch))).rejects.toThrow(/brighterir/);
  });
});

describe('download', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  const ref = parseListing(JSON.parse(listingText) as unknown, 'RMV').refs[0];
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"

  it('returns the HTML and the PDF when the export is a PDF', async () => {
    const { fetch, calls } = stubFetch((url) => {
      if (url.endsWith('/export')) {
        return new Response(pdfBytes, { status: 200, headers: { 'content-type': 'application/pdf' } });
      }
      return new Response(storyHtml, { status: 200, headers: { 'content-type': 'text/html; charset=UTF-8' } });
    });

    const objects = await rnsSource.download(ref, ctxWith(fetch));
    expect(objects).toHaveLength(2);
    expect(calls.map((c) => c.url)).toEqual([ref.url, `${ref.url}/export`]);

    const [html, pdf] = objects;
    expect(html.key).toBe('rns/RMV/2023/2023-09-21_xennvzx_transaction-in-own-shares.html');
    expect(html.contentType).toBe('text/html; charset=utf-8');
    expect(typeof html.body).toBe('string');
    expect(html.body as string).toMatch(/^<!doctype html>/);
    expect(html.body as string).toContain('<title>Transaction in Own Shares</title>');
    expect(html.body as string).toContain('Trading Update');
    expect(html.meta?.storyUrl).toBe(ref.url);
    expect(html.meta?.id).toBe('xennvzx');

    expect(pdf.key).toBe('rns/RMV/2023/2023-09-21_xennvzx_transaction-in-own-shares.pdf');
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.body).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(pdf.body as ArrayBuffer)).toEqual(pdfBytes);
  });

  it('returns only the HTML when the export is a 404', async () => {
    const { fetch } = stubFetch((url) => {
      if (url.endsWith('/export')) return new Response('not found', { status: 404 });
      return new Response(storyHtml, { status: 200, headers: { 'content-type': 'text/html' } });
    });

    const objects = await rnsSource.download(ref, ctxWith(fetch));
    expect(objects).toHaveLength(1);
    expect(objects[0].key).toMatch(/\.html$/);
  });

  it('throws when the story page itself fails', async () => {
    const { fetch } = stubFetch(() => new Response('oops', { status: 500 }));
    await expect(rnsSource.download(ref, ctxWith(fetch))).rejects.toThrow(/500/);
  });
});
