/**
 * London Stock Exchange RNS regulatory announcements, read from the BrighterIR
 * ("polaris") investor-relations site that hosts each issuer's full history.
 *
 *   listing  GET {base}?show=100&date_start=DD-MM-YYYY&date_end=DD-MM-YYYY&filter=all&draw=1&start=N&length=100
 *            (JSON only when the XHR headers are sent; otherwise the HTML shell)
 *   story    GET {base}/story/{id}           announcement body inside <div class="xn-content">
 *   pdf      GET {base}/story/{id}/export    optional; kept only when the server answers with a PDF
 *
 * Pure parsing lives in parseListing / extractStoryHtml; all I/O goes through ctx.fetch.
 */

import type { FilingRef, Holding, ListMode, ListPage, Source, SourceContext, StoredObject } from '../types';
import { decodeEntities, dmyToIso, slugify, textOf, to24h, yearOf } from '../util';

const ORIGIN = 'https://polaris.brighterir.com';
const PAGE_SIZE = 100;
const FULL_START = '01-01-1990';
const RECENT_DAYS = 60;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/** Parse one BrighterIR listing response. Rows without a story link or date are skipped. */
export function parseListing(json: unknown, ticker: string): { refs: FilingRef[]; recordsTotal: number } {
  if (!json || typeof json !== 'object') throw new Error('rns listing: response is not a JSON object');
  const body = json as { data?: unknown; recordsTotal?: unknown };
  if (!Array.isArray(body.data)) throw new Error('rns listing: response has no data array');
  if (typeof body.recordsTotal !== 'number' || !Number.isFinite(body.recordsTotal)) {
    throw new Error('rns listing: response has no numeric recordsTotal');
  }

  const refs: FilingRef[] = [];
  for (const row of body.data) {
    const ref = parseRow(row, ticker);
    if (ref) refs.push(ref);
  }
  return { refs, recordsTotal: body.recordsTotal };
}

function parseRow(row: unknown, ticker: string): FilingRef | undefined {
  const r = (row ?? {}) as Record<string, unknown>;
  const headline = typeof r.headline === 'string' ? r.headline : '';
  const anchor = headline.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
  const href = anchor ? attr(anchor[1], 'href') : undefined;

  let storyUrl: string | undefined;
  let storyId: string | undefined;
  if (href) {
    try {
      const u = new URL(decodeEntities(href), ORIGIN);
      storyId = u.pathname.match(/\/story\/([^/]+)\/?$/)?.[1];
      if (storyId) storyUrl = u.toString();
    } catch {
      storyId = undefined;
    }
  }
  if (!storyId || !storyUrl || !anchor) {
    console.warn(`rns: skipping listing row ${String(r.id)}: no story link`);
    return undefined;
  }

  const title = textOf(anchor[2]) || textOf(headline);

  const stamp = typeof r.timestamp === 'string' ? r.timestamp : '';
  const dateTag = timeOfClass(stamp, 'formatted_date');
  let date = dateTag?.datetime && /^\d{4}-\d{2}-\d{2}$/.test(dateTag.datetime) ? dateTag.datetime : undefined;
  if (!date) {
    const dmy = (dateTag?.text ?? textOf(stamp)).match(/\d{1,2}\/\d{1,2}\/\d{4}/);
    if (dmy) {
      try {
        date = dmyToIso(dmy[0]);
      } catch {
        date = undefined;
      }
    }
  }
  if (!date) {
    console.warn(`rns: skipping ${storyId}: no publication date`);
    return undefined;
  }

  const timeTag = timeOfClass(stamp, 'formatted_time');
  const time =
    timeTag?.datetime && /^\d{2}:\d{2}$/.test(timeTag.datetime)
      ? timeTag.datetime
      : timeTag?.text
        ? to24h(timeTag.text)
        : undefined;

  const category = typeof r.category === 'string' ? r.category.trim() : '';
  const provider = typeof r.provider === 'string' ? r.provider.trim() : '';

  return {
    source: 'rns',
    ticker,
    id: storyId,
    date,
    time,
    title,
    form: category || provider || undefined,
    url: storyUrl,
    extra: {
      listingId: r.id,
      provider,
      regulatory: r.regulatory,
      category,
      pdfUrl: `${storyUrl.replace(/\/+$/, '')}/export`,
    },
  };
}

// ---------------------------------------------------------------------------
// Story page
// ---------------------------------------------------------------------------

/**
 * Pull the announcement out of a BrighterIR story page.
 *
 * - contentHtml: inner markup of the first <div class="xn-content"> (balanced-div scan),
 *   or the whole <body> when that class is absent. Markup is kept as-is.
 * - title: <title>, then og:title, then the first <h1>, then `fallbackTitle`.
 * - date / time: from the first <chron> element that looks like a full date / a clock time.
 */
export function extractStoryHtml(
  html: string,
  fallbackTitle = '',
): { title: string; contentHtml: string; date?: string; time?: string } {
  const contentHtml = xnContent(html).trim();
  const title = pageTitle(html) || fallbackTitle;
  const { date, time } = storyDateTime(contentHtml);
  return { title, contentHtml, date, time };
}

function xnContent(html: string): string {
  for (const open of html.matchAll(/<div\b[^>]*>/gi)) {
    if (!/\bclass\s*=\s*["'][^"']*\bxn-content\b/i.test(open[0])) continue;
    const inner = divInner(html, (open.index ?? 0) + open[0].length);
    if (inner !== undefined) return inner;
    break;
  }
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body ? body[1] : html;
}

/** Text between `from` and the </div> that closes the already-open element at `from`. */
function divInner(html: string, from: number): string | undefined {
  const re = /<(\/?)div\b[^>]*>/gi;
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] === '/') {
      depth--;
      if (depth === 0) return html.slice(from, m.index);
    } else if (!m[0].endsWith('/>')) {
      depth++;
    }
  }
  return undefined;
}

function pageTitle(html: string): string {
  const t = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (t) {
    const s = textOf(t[1]);
    if (s) return s;
  }
  const og = html.match(/<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*>/i);
  const ogContent = og ? attr(og[0], 'content') : undefined;
  if (ogContent) return ogContent;
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const s = textOf(h1[1]);
    if (s) return s;
  }
  return '';
}

function storyDateTime(content: string): { date?: string; time?: string } {
  let date: string | undefined;
  let time: string | undefined;
  for (const m of content.matchAll(/<chron\b[^>]*>([\s\S]*?)<\/chron>/gi)) {
    const text = textOf(m[1]);
    if (!date) {
      const d = text.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})$/);
      const month = d ? MONTHS.indexOf(d[2].toLowerCase()) : -1;
      if (d && month >= 0) date = `${d[3]}-${String(month + 1).padStart(2, '0')}-${d[1].padStart(2, '0')}`;
    }
    if (!time && /^\d{1,2}:\d{2}/.test(text)) time = to24h(text);
    if (date && time) break;
  }
  return { date, time };
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

function requireSlug(holding: Holding): string {
  const slug = holding.brighterir?.trim();
  if (!slug) throw new Error(`rns: holding ${holding.ticker} has no brighterir client slug (Holding.brighterir)`);
  return slug;
}

function baseUrl(slug: string): string {
  return `${ORIGIN}/public/${encodeURIComponent(slug)}/news/html_rns_announcements`;
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0;
  if (!/^\d+$/.test(cursor)) throw new Error(`rns: bad cursor "${cursor}"`);
  return Number(cursor);
}

/** DD-MM-YYYY in UTC. */
function fmtDmy(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

async function list(holding: Holding, mode: ListMode, cursor: string | undefined, ctx: SourceContext): Promise<ListPage> {
  const slug = requireSlug(holding);
  const offset = parseCursor(cursor);

  const now = ctx.now();
  const dateEnd = fmtDmy(addDays(now, 1));
  const dateStart = mode === 'full' ? FULL_START : fmtDmy(addDays(now, -RECENT_DAYS));
  const url =
    `${baseUrl(slug)}?show=${PAGE_SIZE}&date_start=${dateStart}&date_end=${dateEnd}` +
    `&filter=all&draw=1&start=${offset}&length=${PAGE_SIZE}`;

  const res = await ctx.fetch(url, {
    headers: {
      'x-requested-with': 'XMLHttpRequest',
      accept: 'application/json',
      'user-agent': USER_AGENT,
    },
  });
  if (!res.ok) throw new Error(`rns listing ${holding.ticker} start=${offset}: HTTP ${res.status}`);

  let json: unknown;
  try {
    json = JSON.parse(await res.text());
  } catch {
    throw new Error(`rns listing ${holding.ticker} start=${offset}: response is not JSON`);
  }

  const { refs, recordsTotal } = parseListing(json, holding.ticker);
  const next = offset + PAGE_SIZE;
  return { refs, nextCursor: next < recordsTotal ? String(next) : undefined };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function download(ref: FilingRef, ctx: SourceContext): Promise<StoredObject[]> {
  const storyRes = await ctx.fetch(ref.url, {
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
    },
  });
  if (!storyRes.ok) throw new Error(`rns story ${ref.id}: HTTP ${storyRes.status}`);

  const story = extractStoryHtml(await storyRes.text(), ref.title);
  const title = story.title || ref.title || ref.id;
  const stem = `rns/${ref.ticker}/${yearOf(ref.date)}/${ref.date}_${ref.id}_${slugify(ref.title || title)}`;
  const meta = { ...ref, storyUrl: ref.url };

  const doc =
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
    `<body>${story.contentHtml}</body></html>`;

  const objects: StoredObject[] = [
    { key: `${stem}.html`, body: doc, contentType: 'text/html; charset=utf-8', meta },
  ];

  try {
    const pdfRes = await ctx.fetch(`${ref.url.replace(/\/+$/, '')}/export`, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/pdf,*/*;q=0.8' },
    });
    const ct = pdfRes.headers.get('content-type') ?? '';
    if (pdfRes.status === 200 && ct.toLowerCase().includes('application/pdf')) {
      objects.push({ key: `${stem}.pdf`, body: await pdfRes.arrayBuffer(), contentType: 'application/pdf', meta });
    } else {
      console.warn(`rns: no PDF export for ${ref.id} (HTTP ${pdfRes.status}, ${ct || 'no content-type'})`);
    }
  } catch (err) {
    console.warn(`rns: PDF export failed for ${ref.id}: ${err instanceof Error ? err.message : String(err)}`);
  }

  return objects;
}

export const rnsSource: Source = {
  id: 'rns',
  minDelayMs: 400,
  concurrency: 3,
  list,
  download,
};

// ---------------------------------------------------------------------------
// Small HTML helpers
// ---------------------------------------------------------------------------

/** Value of one attribute inside a tag's attribute string (or a whole tag). */
function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return m ? decodeEntities(m[2]).trim() : undefined;
}

/** The first <time> element whose class list contains `cls`. */
function timeOfClass(html: string, cls: string): { datetime?: string; text: string } | undefined {
  for (const t of html.matchAll(/<time\b([^>]*)>([\s\S]*?)<\/time>/gi)) {
    const classes = (attr(t[1], 'class') ?? '').split(/\s+/);
    if (classes.includes(cls)) return { datetime: attr(t[1], 'datetime'), text: textOf(t[2]) };
  }
  return undefined;
}
