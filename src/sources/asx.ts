/**
 * ASX company announcements source.
 *
 * Two listings are combined:
 *  - the historical per-year archive (HTML, 1998..today), keyed by the ASX code
 *    (`holding.asxArchiveCode ?? holding.ticker`), and
 *  - the Markit Digital "recent announcements" JSON (latest 5, keyed by ticker),
 *    which also covers hybrids / ETFs the archive does not know.
 *
 * Archive rows and Markit items share the same numeric id (the archive `idsId`),
 * so the caller de-duplicates them.
 */

import type { FilingRef, Holding, ListMode, ListPage, Source, SourceContext, StoredObject } from '../types';
import { decodeEntities, dmyToIso, slugify, textOf, to24h, yearOf } from '../util';

const ASX_STATS_BASE = 'https://www.asx.com.au/asx/v2/statistics/';
const ARCHIVE_URL = `${ASX_STATS_BASE}announcements.do`;
const MARKIT_BASE = 'https://asx.api.markitdigital.com/asx-research/1.0';
const FIRST_ARCHIVE_YEAR = 1998;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const PDF_ACCEPT = 'application/pdf,*/*;q=0.8';
const JSON_ACCEPT = 'application/json,text/plain;q=0.9,*/*;q=0.8';

function requestInit(accept: string): RequestInit {
  return { headers: { 'user-agent': USER_AGENT, accept } };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Time zone helpers (Australia/Sydney calendar date / time of an instant)
// ---------------------------------------------------------------------------

const SYDNEY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Australia/Sydney',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

interface SydneyParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
}

function sydneyParts(d: Date): SydneyParts {
  const m: Record<string, string> = {};
  for (const p of SYDNEY_FORMAT.formatToParts(d)) m[p.type] = p.value;
  return { year: m.year, month: m.month, day: m.day, hour: m.hour, minute: m.minute };
}

// ---------------------------------------------------------------------------
// Archive (HTML) parsing
// ---------------------------------------------------------------------------

const ROW_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL_RE = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
const ANCHOR_RE = /<a\b[^>]*?href\s*=\s*["']([^"']*displayAnnouncement\.do[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i;
const DATE_RE = /(\d{1,2}\/\d{1,2}\/\d{4})/;
const TIME_RE = /<span[^>]*\bdates-time\b[^>]*>([\s\S]*?)<\/span>/i;
const PAGES_RE = /<span[^>]*\bclass\s*=\s*["']page["'][^>]*>\s*(\d+)/i;
const PRICE_SENSITIVE_RE = /title\s*=\s*["']price sensitive["']/i;
const PRICESENS_CELL_RE = /\bclass\s*=\s*["'][^"']*\bpricesens\b/i;

/** Read a query parameter from an already entity-decoded href. */
function queryParam(href: string, name: string): string | undefined {
  const m = new RegExp(`[?&]${name}=([^&#"'\\s]+)`).exec(href);
  return m ? m[1] : undefined;
}

/**
 * Parse one year of the historical announcements archive.
 * Rows without an announcement link (headers, search form, empty result) are ignored,
 * so an empty or unknown-code page yields []. Rows whose date cannot be read are
 * skipped with a warning.
 */
export function parseArchivePage(html: string, ticker: string, archiveCode: string): FilingRef[] {
  const refs: FilingRef[] = [];
  for (const rowMatch of html.matchAll(ROW_RE)) {
    const row = rowMatch[1];
    const anchor = ANCHOR_RE.exec(row);
    if (!anchor) continue;

    const href = decodeEntities(anchor[1]);
    const cells = [...row.matchAll(CELL_RE)];
    const dateCell = cells[0];
    const dateMatch = dateCell ? DATE_RE.exec(dateCell[2]) : null;
    if (!dateMatch) {
      console.warn(`asx: archive row without a date skipped (${ticker}, ${archiveCode}): ${href}`);
      continue;
    }
    const date = dmyToIso(dateMatch[1]);

    const timeMatch = TIME_RE.exec(dateCell[2]);
    const time = timeMatch ? to24h(textOf(timeMatch[1])) : undefined;

    const psCell = cells.find((c) => PRICESENS_CELL_RE.test(c[1]));
    const priceSensitive = psCell ? PRICE_SENSITIVE_RE.test(psCell[2]) : false;

    // Title is the anchor text before the first <br>.
    const title = textOf(anchor[2].split(/<br\s*\/?>/i)[0]);
    const url = new URL(href, ASX_STATS_BASE).toString();

    const idsId = queryParam(href, 'idsId');
    if (idsId) {
      const pagesMatch = PAGES_RE.exec(anchor[2]);
      refs.push({
        source: 'asx',
        ticker,
        id: idsId,
        date,
        time,
        title,
        url,
        extra: {
          priceSensitive,
          pages: pagesMatch ? Number(pagesMatch[1]) : undefined,
          archiveCode,
          legacy: false,
        },
      });
      continue;
    }

    const documentNumber = queryParam(href, 'documentNumber');
    if (!documentNumber) {
      console.warn(`asx: archive row with unrecognised link skipped (${ticker}): ${href}`);
      continue;
    }
    refs.push({
      source: 'asx',
      ticker,
      id: `doc-${documentNumber}`,
      date,
      time,
      title,
      url,
      extra: {
        priceSensitive,
        archiveCode,
        legacy: true,
        issuerId: queryParam(href, 'issuerId'),
        documentNumber,
        documentDate: queryParam(href, 'documentDate'),
      },
    });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Markit recent announcements (JSON)
// ---------------------------------------------------------------------------

interface MarkitItem {
  announcementType?: string;
  date?: string;
  documentKey?: string;
  fileSize?: string;
  headline?: string;
  isPriceSensitive?: boolean;
}

/**
 * Parse the Markit "recent announcements" JSON body (latest 5 items).
 * Items are returned in the API order (newest first). Throws on invalid JSON.
 */
export function parseMarkitRecent(body: string, ticker: string): FilingRef[] {
  const json = JSON.parse(body) as { data?: { items?: MarkitItem[] }; items?: MarkitItem[] };
  const items = json.data?.items ?? json.items ?? [];
  const refs: FilingRef[] = [];
  for (const item of items) {
    // documentKey looks like "2924-03151740-3A704697"; the middle segment is the idsId.
    const id = (item.documentKey ?? '').split('-')[1];
    if (!id || !/^\d+$/.test(id)) {
      console.warn(`asx: markit item without a usable documentKey skipped (${ticker}): ${item.documentKey}`);
      continue;
    }
    const when = item.date ? new Date(item.date) : null;
    if (!when || Number.isNaN(when.getTime())) continue;
    const p = sydneyParts(when);
    refs.push({
      source: 'asx',
      ticker,
      id,
      date: `${p.year}-${p.month}-${p.day}`,
      time: `${p.hour}:${p.minute}`,
      title: (item.headline ?? '').replace(/\s+/g, ' ').trim(),
      form: item.announcementType,
      url: `${ASX_STATS_BASE}displayAnnouncement.do?display=pdf&idsId=${id}`,
      extra: {
        priceSensitive: item.isPriceSensitive === true,
        fileSize: item.fileSize,
        documentKey: item.documentKey,
        legacy: false,
      },
    });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

const PDF_LINK_RE = /https:\/\/announcements\.asx\.com\.au\/asxpdf\/[^"'\s<>]+\.pdf/i;

/** Extract the direct PDF URL from the displayAnnouncement.do interstitial page. */
export function parseInterstitialPdfUrl(html: string): string | undefined {
  const inputs = html.match(/<input\b[^>]*>/gi) ?? [];
  for (const tag of inputs) {
    if (!/name\s*=\s*["']pdfURL["']/i.test(tag)) continue;
    const value = /\svalue\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (value) return decodeEntities(value[1]);
  }
  const any = PDF_LINK_RE.exec(html);
  return any ? decodeEntities(any[0]) : undefined;
}

export interface LegacyPart {
  /** Part label as shown on the header page, e.g. "Part A". */
  part: string;
  announcementId: string;
  /** Absolute URL of the part's text page. */
  url: string;
}

const LEGACY_PART_RE =
  /<a\b[^>]*?href\s*=\s*["']([^"']*displayAnnouncement\.do[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

/** Parse the legacy header page into its text parts, in page order. */
export function parseLegacyHeaderParts(html: string): LegacyPart[] {
  const parts: LegacyPart[] = [];
  for (const m of html.matchAll(LEGACY_PART_RE)) {
    const href = decodeEntities(m[1]);
    if (!/[?&]display=text(&|$)/.test(href)) continue;
    const announcementId = queryParam(href, 'announcementId');
    if (!announcementId) continue;
    parts.push({
      part: textOf(m[2]),
      announcementId,
      url: new URL(href, ASX_STATS_BASE).toString(),
    });
  }
  return parts;
}

/** Extract the plain text of a legacy announcement part (the content of its <pre> block). */
export function parseLegacyText(html: string): string {
  const m = /<pre\b[^>]*>([\s\S]*?)<\/pre>/i.exec(html);
  if (!m) throw new Error('asx legacy text page has no <pre> block');
  // The HTML parser drops a single newline directly after <pre>; mirror that.
  const raw = m[1].replace(/^\r?\n/, '').replace(/<[^>]+>/g, '');
  return decodeEntities(raw).replace(/\s+$/, '');
}

function isPdfResponse(r: Response): boolean {
  return r.ok && /application\/pdf/i.test(r.headers.get('content-type') ?? '');
}

async function downloadIdsIdPdf(ref: FilingRef, ctx: SourceContext): Promise<StoredObject[]> {
  const notes: string[] = [];
  let body: ArrayBuffer | undefined;
  let pdfUrl: string | undefined;

  // 1. Interstitial page -> direct PDF URL -> PDF bytes.
  try {
    const interstitial = await ctx.fetch(ref.url, requestInit(HTML_ACCEPT));
    if (interstitial.ok) {
      const found = parseInterstitialPdfUrl(await interstitial.text());
      if (found) {
        const r = await ctx.fetch(found, requestInit(PDF_ACCEPT));
        if (isPdfResponse(r)) {
          body = await r.arrayBuffer();
          pdfUrl = found;
        } else {
          notes.push(`pdf ${found} -> HTTP ${r.status} ${r.headers.get('content-type') ?? ''}`.trim());
        }
      } else {
        notes.push('no pdf url in interstitial');
      }
    } else {
      notes.push(`interstitial HTTP ${interstitial.status}`);
    }
  } catch (e) {
    notes.push(`interstitial/pdf error: ${errorMessage(e)}`);
  }

  // 2. Fallback: Markit file endpoint.
  if (!body) {
    const fallback = `${MARKIT_BASE}/file/2924-${ref.id}`;
    try {
      const r = await ctx.fetch(fallback, requestInit(PDF_ACCEPT));
      if (isPdfResponse(r)) {
        body = await r.arrayBuffer();
        pdfUrl = fallback;
      } else {
        notes.push(`markit file HTTP ${r.status} ${r.headers.get('content-type') ?? ''}`.trim());
      }
    } catch (e) {
      notes.push(`markit file error: ${errorMessage(e)}`);
    }
  }

  if (!body || !pdfUrl) {
    throw new Error(`asx: could not download announcement ${ref.ticker} idsId=${ref.id}: ${notes.join('; ')}`);
  }

  return [
    {
      key: `asx/${ref.ticker}/${yearOf(ref.date)}/${ref.date}_${ref.id}_${slugify(ref.title)}.pdf`,
      body,
      contentType: 'application/pdf',
      meta: { ...ref, pdfUrl },
    },
  ];
}

async function downloadLegacyText(ref: FilingRef, ctx: SourceContext): Promise<StoredObject[]> {
  const header = await ctx.fetch(ref.url, requestInit(HTML_ACCEPT));
  if (!header.ok) throw new Error(`asx: legacy header ${ref.ticker} ${ref.id} HTTP ${header.status}`);
  const parts = parseLegacyHeaderParts(await header.text());
  if (parts.length === 0) throw new Error(`asx: legacy header ${ref.ticker} ${ref.id} lists no document parts`);

  const texts: string[] = [];
  for (const part of parts) {
    const r = await ctx.fetch(part.url, requestInit(HTML_ACCEPT));
    if (!r.ok) throw new Error(`asx: legacy part ${part.url} HTTP ${r.status}`);
    texts.push(parseLegacyText(await r.text()));
  }

  let body = texts[0];
  for (let i = 1; i < texts.length; i++) {
    body += `\n\n===== Part ${i + 1} =====\n\n${texts[i]}`;
  }
  body += '\n';

  const documentNumber = String(ref.extra?.documentNumber ?? ref.id.replace(/^doc-/, ''));
  return [
    {
      key: `asx/${ref.ticker}/${yearOf(ref.date)}/${ref.date}_doc${documentNumber}_${slugify(ref.title)}.txt`,
      body,
      contentType: 'text/plain; charset=utf-8',
      meta: { ...ref, parts: parts.map((p) => p.url) },
    },
  ];
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

const YEAR_CURSOR_RE = /^year:(\d{4})$/;

async function listRecentMarkit(holding: Holding, ctx: SourceContext): Promise<FilingRef[]> {
  const url = `${MARKIT_BASE}/companies/${encodeURIComponent(holding.ticker)}/announcements?count=20`;
  try {
    const r = await ctx.fetch(url, requestInit(JSON_ACCEPT));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return parseMarkitRecent(await r.text(), holding.ticker);
  } catch (e) {
    console.warn(`asx: markit recent announcements failed for ${holding.ticker}: ${errorMessage(e)}`);
    return [];
  }
}

export const asxSource: Source = {
  id: 'asx',
  minDelayMs: 300,
  concurrency: 5,
  shards: 6,

  async list(holding: Holding, mode: ListMode, cursor: string | undefined, ctx: SourceContext): Promise<ListPage> {
    const now = ctx.now();
    const thisYear = Number(sydneyParts(now).year);

    if (cursor === undefined) {
      const refs = await listRecentMarkit(holding, ctx);
      return { refs, nextCursor: `year:${thisYear}` };
    }

    const m = YEAR_CURSOR_RE.exec(cursor);
    if (!m) throw new Error(`asx: unrecognised cursor ${cursor}`);
    const year = Number(m[1]);
    if (year < FIRST_ARCHIVE_YEAR) return { refs: [] };

    const archiveCode = holding.asxArchiveCode ?? holding.ticker;
    const url = new URL(ARCHIVE_URL);
    url.searchParams.set('by', 'asxCode');
    url.searchParams.set('asxCode', archiveCode);
    url.searchParams.set('timeframe', 'Y');
    url.searchParams.set('year', String(year));

    const r = await ctx.fetch(url.toString(), requestInit(HTML_ACCEPT));
    if (!r.ok) throw new Error(`asx: archive ${archiveCode} ${year} HTTP ${r.status}`);
    const refs = parseArchivePage(await r.text(), holding.ticker, archiveCode);

    let nextCursor: string | undefined;
    if (mode === 'full') {
      nextCursor = year - 1 >= FIRST_ARCHIVE_YEAR ? `year:${year - 1}` : undefined;
    } else {
      const p = sydneyParts(now);
      const earlyJanuary = p.month === '01' && Number(p.day) <= 14;
      nextCursor = year === thisYear && earlyJanuary ? `year:${year - 1}` : undefined;
    }
    return { refs, nextCursor };
  },

  async download(ref: FilingRef, ctx: SourceContext): Promise<StoredObject[]> {
    if (ref.extra?.legacy === true) return downloadLegacyText(ref, ctx);
    return downloadIdsIdPdf(ref, ctx);
  },
};
