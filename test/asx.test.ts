import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  asxSource,
  parseArchivePage,
  parseInterstitialPdfUrl,
  parseLegacyHeaderParts,
  parseLegacyText,
  parseMarkitRecent,
} from '../src/sources/asx';
import type { Fetcher, Holding, SourceContext } from '../src/types';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtureText = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const BHP: Holding = { ticker: 'BHP', exchange: 'XASX', name: 'BHP Group', sources: ['asx'] };
const NOW = new Date('2026-10-30T02:00:00Z');
const PDF_BYTES = new TextEncoder().encode('%PDF-1.4 fake pdf bytes');
const PDF_URL = 'https://announcements.asx.com.au/asxpdf/20261013/pdf/07589cq22kn8mn.pdf';
const MARKIT_FILE_2024_02897739 = 'https://asx.api.markitdigital.com/asx-research/1.0/file/2924-02897739';

type Handler = (url: string) => Response;

interface Stub {
  ctx: SourceContext;
  calls: string[];
}

/**
 * Build a SourceContext whose fetch is answered by the first matching route.
 * Unmatched URLs get a 404.
 */
function stub(routes: Array<[(url: string) => boolean, Handler]>, now: Date = NOW): Stub {
  const calls: string[] = [];
  const fetch: Fetcher = async (url: string) => {
    calls.push(url);
    for (const [match, respond] of routes) if (match(url)) return respond(url);
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  };
  return { ctx: { fetch, now: () => now }, calls };
}

const html = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
const json = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } });
const pdf = (bytes: Uint8Array, status = 200): Response =>
  new Response(bytes, { status, headers: { 'content-type': 'application/pdf' } });

const isArchive = (url: string): boolean => url.includes('/asx/v2/statistics/announcements.do');
const isMarkitRecent = (url: string): boolean =>
  url.startsWith('https://asx.api.markitdigital.com/asx-research/1.0/companies/');

/** Archive pages for the years that have fixtures; every other year is an empty result. */
function archiveFixture(url: string): Response {
  const year = new URL(url).searchParams.get('year');
  const name =
    year === '1998' ? 'asx_archive_BHP_1998.html'
    : year === '2002' ? 'asx_archive_BHP_2002.html'
    : year === '2024' ? 'asx_archive_BHP_2024.html'
    : 'asx_archive_empty.html';
  return html(fixtureText(name));
}

const markitFixture = (): Response => json(fixtureText('asx_markit_BHP.json'));

/** Routes for a normal BHP run: markit recent plus archive years from fixtures. */
const bhpRoutes: Array<[(url: string) => boolean, Handler]> = [
  [isMarkitRecent, markitFixture],
  [isArchive, archiveFixture],
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseArchivePage', () => {
  it('counts the rows of each archive fixture', () => {
    expect(parseArchivePage(fixtureText('asx_archive_BHP_2024.html'), 'BHP', 'BHP')).toHaveLength(80);
    expect(parseArchivePage(fixtureText('asx_archive_BHP_1998.html'), 'BHP', 'BHP')).toHaveLength(279);
    expect(parseArchivePage(fixtureText('asx_archive_BHP_2002.html'), 'BHP', 'BHP')).toHaveLength(267);
    expect(parseArchivePage(fixtureText('asx_archive_empty.html'), 'BHP', 'GSBE47')).toEqual([]);
  });

  it('splits the 2002 archive into 51 idsId rows and 216 legacy rows', () => {
    const refs = parseArchivePage(fixtureText('asx_archive_BHP_2002.html'), 'BHP', 'BHP');
    expect(refs.filter((r) => r.extra?.legacy === false)).toHaveLength(51);
    expect(refs.filter((r) => r.extra?.legacy === true)).toHaveLength(216);
  });

  it('parses the first 2024 row', () => {
    const [first] = parseArchivePage(fixtureText('asx_archive_BHP_2024.html'), 'BHP', 'BHP');
    expect(first).toEqual({
      source: 'asx',
      ticker: 'BHP',
      id: '02897739',
      date: '2024-12-18',
      time: '16:51',
      title: 'Federal Court of Australia Class Action Proceeding',
      url: 'https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=02897739',
      extra: { priceSensitive: false, pages: 2, archiveCode: 'BHP', legacy: false },
    });
  });

  it('detects both price-sensitive and non-sensitive rows in 2024', () => {
    const refs = parseArchivePage(fixtureText('asx_archive_BHP_2024.html'), 'BHP', 'BHP');
    expect(refs.filter((r) => r.extra?.priceSensitive === true)).toHaveLength(15);
    expect(refs.some((r) => r.extra?.priceSensitive === false)).toBe(true);
  });

  it('parses the first legacy 1998 row', () => {
    const [first] = parseArchivePage(fixtureText('asx_archive_BHP_1998.html'), 'BHP', 'BHP');
    expect(first).toEqual({
      source: 'asx',
      ticker: 'BHP',
      id: 'doc-144356',
      date: '1998-12-30',
      time: '00:00',
      title: 'Section 235 Notice - Director`s Interests',
      url: 'https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=header&issuerId=173&documentNumber=144356&documentDate=1998-12-30',
      extra: {
        priceSensitive: false,
        archiveCode: 'BHP',
        legacy: true,
        issuerId: '173',
        documentNumber: '144356',
        documentDate: '1998-12-30',
      },
    });
  });

  it('decodes entities in legacy titles', () => {
    const refs = parseArchivePage(fixtureText('asx_archive_BHP_2002.html'), 'BHP', 'BHP');
    expect(refs.find((r) => r.id === 'doc-229552')?.title).toBe(
      'WMM: Signs off on alliance & share placement to BHP Billiton',
    );
  });
});

describe('parseInterstitialPdfUrl', () => {
  it('returns the announcements.asx.com.au PDF URL', () => {
    expect(parseInterstitialPdfUrl(fixtureText('asx_interstitial.html'))).toBe(PDF_URL);
  });

  it('returns undefined when the page has no PDF URL', () => {
    expect(parseInterstitialPdfUrl('<html><body>nothing here</body></html>')).toBeUndefined();
  });
});

describe('legacy parsing', () => {
  it('parseLegacyHeaderParts finds one part with announcementId 368903', () => {
    const parts = parseLegacyHeaderParts(fixtureText('asx_legacy_header.html'));
    expect(parts).toHaveLength(1);
    expect(parts[0].announcementId).toBe('368903');
    expect(parts[0].part).toBe('Part A');
    expect(parts[0].url).toBe(
      'https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=text&issuerId=173&announcementId=368903&documentDate=1998-12-30&documentNumber=144356',
    );
  });

  it('parseLegacyText returns the <pre> content', () => {
    const text = parseLegacyText(fixtureText('asx_legacy_text.html'));
    expect(text.startsWith('HOMEX - Melbourne')).toBe(true);
    expect(text).toContain("NOTICE OF DIRECTOR'S INTERESTS");
  });

  it('parseLegacyText throws when there is no <pre> block', () => {
    expect(() => parseLegacyText('<html><body>no text</body></html>')).toThrow(/no <pre>/);
  });
});

describe('parseMarkitRecent', () => {
  it('returns the 5 recent items, newest first, with Sydney dates', () => {
    const refs = parseMarkitRecent(fixtureText('asx_markit_BHP.json'), 'BHP');
    expect(refs).toHaveLength(5);
    expect(refs[0]).toMatchObject({
      source: 'asx',
      ticker: 'BHP',
      id: '03151740',
      date: '2026-10-22',
      time: '14:38',
      title: 'Results of 2026 Annual General Meeting',
      form: 'NOTICE OF MEETING',
      url: 'https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03151740',
      extra: { priceSensitive: false, fileSize: '217KB', documentKey: '2924-03151740-3A704697', legacy: false },
    });
  });

  it('converts a late-evening UTC instant to the next Sydney day', () => {
    // 2026-10-21T22:45:40Z is 09:45 on 22 October in Sydney (AEDT, UTC+11).
    const refs = parseMarkitRecent(fixtureText('asx_markit_BHP.json'), 'BHP');
    expect(refs[1]).toMatchObject({ id: '03151588', date: '2026-10-22', time: '09:45' });
  });

  it('keeps the price-sensitive flag', () => {
    const refs = parseMarkitRecent(fixtureText('asx_markit_BHP.json'), 'BHP');
    expect(refs.find((r) => r.id === '03150302')?.extra?.priceSensitive).toBe(true);
  });
});

describe('list()', () => {
  it('starts with markit recent, then the current-year archive', async () => {
    const { ctx, calls } = stub(bhpRoutes);

    const first = await asxSource.list(BHP, 'full', undefined, ctx);
    expect(first.refs).toHaveLength(5);
    expect(first.nextCursor).toBe('year:2026');

    const second = await asxSource.list(BHP, 'full', first.nextCursor, ctx);
    expect(second.refs).toEqual([]); // 2026 archive is the empty fixture
    expect(second.nextCursor).toBe('year:2025');

    const archiveUrl = calls.find(isArchive) ?? '';
    expect(archiveUrl).toContain('by=asxCode');
    expect(archiveUrl).toContain('asxCode=BHP');
    expect(archiveUrl).toContain('timeframe=Y');
    expect(archiveUrl).toContain('year=2026');
  });

  it('walks the full-mode chain from 2026 down to 1998 and then stops', async () => {
    const { ctx, calls } = stub(bhpRoutes);

    let cursor: string | undefined;
    const cursors: string[] = [];
    let total = 0;
    do {
      const page = await asxSource.list(BHP, 'full', cursor, ctx);
      total += page.refs.length;
      cursor = page.nextCursor;
      if (cursor !== undefined) cursors.push(cursor);
    } while (cursor !== undefined);

    expect(cursors[0]).toBe('year:2026');
    expect(cursors[cursors.length - 1]).toBe('year:1998');
    expect(cursors).toHaveLength(2026 - 1998 + 1);
    expect(calls.filter(isArchive)).toHaveLength(2026 - 1998 + 1);
    // 5 markit refs + the 2024 (80), 2002 (267) and 1998 (279) archive fixtures.
    expect(total).toBe(5 + 80 + 267 + 279);
  });

  it('a 1998 cursor yields no further cursor in full mode', async () => {
    const { ctx } = stub(bhpRoutes);
    const page = await asxSource.list(BHP, 'full', 'year:1998', ctx);
    expect(page.refs).toHaveLength(279);
    expect(page.nextCursor).toBeUndefined();
  });

  it('recent mode stops after the current year outside early January', async () => {
    const { ctx } = stub(bhpRoutes);
    const page = await asxSource.list(BHP, 'recent', 'year:2026', ctx);
    expect(page.nextCursor).toBeUndefined();
  });

  it('recent mode also fetches the previous year during the first 14 days of January', async () => {
    const jan = new Date('2026-01-05T02:00:00Z');
    const { ctx } = stub(bhpRoutes, jan);
    const page = await asxSource.list(BHP, 'recent', 'year:2026', ctx);
    expect(page.nextCursor).toBe('year:2025');
  });

  it('a markit failure is logged and the run continues with an empty step', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx } = stub([
      [isMarkitRecent, () => json('{"error":"boom"}', 503)],
      [isArchive, archiveFixture],
    ]);
    const page = await asxSource.list(BHP, 'full', undefined, ctx);
    expect(page.refs).toEqual([]);
    expect(page.nextCursor).toBe('year:2026');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a markit body that is not JSON is logged and treated as empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ctx } = stub([
      [isMarkitRecent, () => json('<html>oops</html>')],
      [isArchive, archiveFixture],
    ]);
    const page = await asxSource.list(BHP, 'full', undefined, ctx);
    expect(page.refs).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('uses asxArchiveCode for the archive when it differs from the ticker', async () => {
    const hybrid: Holding = { ...BHP, ticker: 'GSBE47', asxArchiveCode: 'GSB' };
    const { ctx, calls } = stub([[isArchive, () => html(fixtureText('asx_archive_empty.html'))]]);
    await asxSource.list(hybrid, 'full', 'year:2024', ctx);
    expect(calls[0]).toContain('asxCode=GSB');
  });
});

describe('download()', () => {
  it('downloads an idsId announcement via the interstitial into one PDF object', async () => {
    const [ref] = parseArchivePage(fixtureText('asx_archive_BHP_2024.html'), 'BHP', 'BHP');
    const { ctx, calls } = stub([
      [(u) => u.includes('display=pdf&idsId=02897739'), () => html(fixtureText('asx_interstitial.html'))],
      [(u) => u === PDF_URL, () => pdf(PDF_BYTES)],
    ]);

    const objects = await asxSource.download(ref, ctx);
    expect(objects).toHaveLength(1);
    const [obj] = objects;
    expect(obj.key).toBe('asx/BHP/2024/2024-12-18_02897739_federal-court-of-australia-class-action-proceeding.pdf');
    expect(obj.contentType).toBe('application/pdf');
    expect(new Uint8Array(obj.body as ArrayBuffer)).toEqual(PDF_BYTES);
    expect(obj.meta).toMatchObject({ id: '02897739', pdfUrl: PDF_URL });
    expect(calls).toEqual([ref.url, PDF_URL]);
  });

  it('falls back to the markit file endpoint when the interstitial PDF returns 404', async () => {
    const [ref] = parseArchivePage(fixtureText('asx_archive_BHP_2024.html'), 'BHP', 'BHP');
    const { ctx, calls } = stub([
      [(u) => u.includes('display=pdf&idsId=02897739'), () => html(fixtureText('asx_interstitial.html'))],
      [(u) => u.includes('announcements.asx.com.au/asxpdf/'), () => html('gone', 404)],
      [(u) => u === MARKIT_FILE_2024_02897739, () => pdf(PDF_BYTES)],
    ]);

    const [obj] = await asxSource.download(ref, ctx);
    expect(obj.key).toBe('asx/BHP/2024/2024-12-18_02897739_federal-court-of-australia-class-action-proceeding.pdf');
    expect(new Uint8Array(obj.body as ArrayBuffer)).toEqual(PDF_BYTES);
    expect(obj.meta).toMatchObject({ pdfUrl: MARKIT_FILE_2024_02897739 });
    expect(calls).toContain(MARKIT_FILE_2024_02897739);
  });

  it('throws a descriptive error when both the interstitial and the fallback fail', async () => {
    const [ref] = parseArchivePage(fixtureText('asx_archive_BHP_2024.html'), 'BHP', 'BHP');
    const { ctx } = stub([
      [(u) => u.includes('display=pdf&idsId=02897739'), () => html(fixtureText('asx_interstitial.html'))],
    ]);
    await expect(asxSource.download(ref, ctx)).rejects.toThrow(/could not download announcement BHP idsId=02897739/);
  });

  it('downloads a legacy announcement as one .txt object starting with the HOMEX header', async () => {
    const [ref] = parseArchivePage(fixtureText('asx_archive_BHP_1998.html'), 'BHP', 'BHP');
    const { ctx } = stub([
      [(u) => u.includes('display=header'), () => html(fixtureText('asx_legacy_header.html'))],
      [(u) => u.includes('display=text'), () => html(fixtureText('asx_legacy_text.html'))],
    ]);

    const [obj] = await asxSource.download(ref, ctx);
    expect(obj.key).toBe('asx/BHP/1998/1998-12-30_doc144356_section-235-notice-director-s-interests.txt');
    expect(obj.contentType).toBe('text/plain; charset=utf-8');
    expect(typeof obj.body).toBe('string');
    expect((obj.body as string).startsWith('HOMEX - Melbourne')).toBe(true);
  });

  it('joins multiple legacy parts with part separators, in header order', async () => {
    const [ref] = parseArchivePage(fixtureText('asx_archive_BHP_1998.html'), 'BHP', 'BHP');
    const twoPartHeader = `
      <p><b>Section 235 Notice</b></p>
      <ul>
        <li><a href="displayAnnouncement.do?display=text&amp;issuerId=173&amp;announcementId=1&amp;documentDate=1998-12-30&amp;documentNumber=144356">Part A</a></li>
        <li><a href="displayAnnouncement.do?display=text&amp;issuerId=173&amp;announcementId=2&amp;documentDate=1998-12-30&amp;documentNumber=144356">Part B</a></li>
      </ul>`;
    const { ctx } = stub([
      [(u) => u.includes('display=header'), () => html(twoPartHeader)],
      [(u) => u.includes('announcementId=1&'), () => html('<pre width="80">FIRST PART</pre>')],
      [(u) => u.includes('announcementId=2&'), () => html('<pre width="80">SECOND PART</pre>')],
    ]);

    const [obj] = await asxSource.download(ref, ctx);
    expect(obj.body).toBe('FIRST PART\n\n===== Part 2 =====\n\nSECOND PART\n');
  });
});
