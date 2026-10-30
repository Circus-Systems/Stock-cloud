/**
 * Adyen N.V. (Euronext Amsterdam) source.
 *
 * Adyen has no filings API. Its regulatory publications (shareholder letters,
 * interim and annual financial statements, Pillar 3 reports, iXBRL packs, AGM
 * documents, business updates) are linked from the investors.adyen.com hub
 * pages `/financials`, `/general-meetings`, `/events` and `/governance`, and from
 * sub-pages those hubs link to (`/financials/...`, `/general-meetings/...`,
 * `/events/...`). `list` crawls the hubs plus one level of sub-pages and returns
 * every document link. Press releases on www.adyen.com/press-and-media are listed
 * from the page's Nuxt payload, one ref per release. `download` fetches one
 * document, or for a press release the page as HTML plus the documents it links.
 *
 * Parsing is regex/string based (no DOM, no libraries). The parser functions
 * are pure and exported for tests.
 */
import type { FilingRef, Holding, ListMode, ListPage, Source, SourceContext, StoredObject } from '../types';
import { decodeEntities, extFromContentType, slugify, textOf, yearOf } from '../util';

const BASE = 'https://investors.adyen.com';
const HUB_PATHS = ['/financials', '/general-meetings', '/events', '/governance'];
const SUBPAGE_PREFIXES = ['/financials/', '/general-meetings/', '/events/'];
const MAX_SUBPAGES = 150;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const PRESS_BASE = 'https://www.adyen.com/press-and-media/';
const PRESS_PAYLOAD_URL = `${PRESS_BASE}_payload.json`;
const MAX_PRESS_ASSETS = 10;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** One anchor cell of a financials/general-meetings table. */
export interface TableDoc {
  /** aria-label of the table, e.g. "Half-year results". */
  table: string;
  /** Row header text, e.g. "Shareholder letter and interim financial statements". */
  row: string;
  /** Year from the table's header row, e.g. "2026". */
  year: string;
  /** aria-label (or link text) of the anchor, e.g. "H1", "H2", "Q3", "2025", "Download PDF". */
  period: string;
  /** Absolute URL of the anchor target. */
  href: string;
}

/** A document link found on a page. */
export interface PageDoc {
  /** Absolute URL. */
  url: string;
  /** Stable id: asset-{n}, dam-{uuid}, or first 16 hex of sha1(url). */
  id: string;
  kind: 'asset' | 'dam' | 'file';
  /** Visible anchor text, whitespace collapsed; may be empty. */
  text: string;
  /** aria-label, may be empty. */
  ariaLabel: string;
  /** data-track-title (the item's name in the page's analytics), may be empty. */
  trackTitle: string;
  /** Last path segment when it carries a file extension. */
  filename?: string;
}

// ---------------------------------------------------------------------------
// Low-level HTML helpers
// ---------------------------------------------------------------------------

interface Tag {
  attrs: Record<string, string>;
  inner: string;
}

/** Parses an attribute string (the part of a tag after the element name). Values are entity-decoded. */
function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of s.matchAll(re)) {
    const name = m[1].toLowerCase();
    if (name in out) continue;
    out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

function anchorsIn(html: string): Tag[] {
  const out: Tag[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    out.push({ attrs: parseAttrs(m[1]), inner: m[2] });
  }
  return out;
}

/** Resolves an href against a base; returns undefined for fragments, mailto, javascript and non-http(s) links. */
function absolutize(href: string | undefined, base: string): string | undefined {
  const h = (href ?? '').trim();
  if (!h || h.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(h)) return undefined;
  try {
    const u = new URL(h, base);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    u.hash = '';
    return u.href;
  } catch {
    return undefined;
  }
}

/** Sub-page key (absolute, no trailing slash) for a link to an investors.adyen.com sub-page, else undefined. */
function subpageKey(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.hostname !== 'investors.adyen.com') return undefined;
  const path = u.pathname.replace(/\/+$/, '');
  if (!SUBPAGE_PREFIXES.some((p) => path.startsWith(p) && path.length > p.length)) return undefined;
  return `${BASE}${path}`;
}

/** First 4-digit year 2010..2039 in any of the given strings. */
function findYear(parts: string[]): string | undefined {
  for (const p of parts) {
    const m = /(?<!\d)(20[1-3]\d)(?!\d)/.exec(p);
    if (m) return m[1];
  }
  return undefined;
}

function pageTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? textOf(m[1]) : '';
}

function filenameOf(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split('/').pop() ?? '';
    const name = decodeURIComponent(last);
    return /\.[a-z0-9]{1,8}$/i.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// SHA-1 (synchronous). parseDocumentLinks is synchronous, but document ids for
// plain files are defined as the first 16 hex chars of sha1Hex(url); this
// computes the same digest. Verified against util.sha1Hex in the tests.
// ---------------------------------------------------------------------------

function sha1Sync(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(padded.length - 4, bitLen >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
}

// ---------------------------------------------------------------------------
// Document classification
// ---------------------------------------------------------------------------

const ASSET_URL = /^https?:\/\/brand\.adyen\.com\/api\/asset\/([^/?#]+)/i;
const DAM_PATH = /^\/dam\/jcr:([^/]+)\//i;
const FILE_EXT = /\.(pdf|xlsx|zip|xhtml|xbrl)$/i;

/**
 * Stable id for a brand.adyen.com asset URL, e.g. ".../api/asset/eyJjbGllbnRJZCI6bnVsbCwiaWQiOjEzNjc2OCwi...:adyen:sig/download"
 * -> "asset-136768". The token's first segment is base64url JSON carrying a numeric `id`.
 * Returns undefined when the URL is not a brand asset or the token does not decode.
 */
export function assetIdFromUrl(url: string): string | undefined {
  const m = ASSET_URL.exec(url.trim());
  if (!m) return undefined;
  const token = m[1].split(':')[0];
  try {
    let b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const json = JSON.parse(atob(b64)) as { id?: unknown } | null;
    const id = json?.id;
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) return `asset-${id}`;
    if (typeof id === 'string' && /^\d+$/.test(id)) return `asset-${id}`;
    return undefined;
  } catch {
    return undefined;
  }
}

function classifyDoc(url: string): { id: string; kind: PageDoc['kind'] } | undefined {
  if (ASSET_URL.test(url)) {
    const id = assetIdFromUrl(url) ?? `asset-${sha1Sync(url).slice(0, 16)}`;
    return { id, kind: 'asset' };
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (/(^|\.)adyen\.com$/i.test(u.hostname)) {
    const dam = DAM_PATH.exec(u.pathname);
    if (dam) return { id: `dam-${dam[1]}`, kind: 'dam' };
  }
  if (FILE_EXT.test(u.pathname)) return { id: sha1Sync(url).slice(0, 16), kind: 'file' };
  return undefined;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

interface Block {
  attrs: Record<string, string>;
  body: string;
}

/** Every `<div role="table">` element, with its body (matched by div nesting depth). */
function tableBlocks(html: string): Block[] {
  const out: Block[] = [];
  const open = /<div\b[^>]*\brole="table"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = open.exec(html))) {
    const bodyStart = m.index + m[0].length;
    const divs = /<div\b[^>]*>|<\/div\s*>/gi;
    divs.lastIndex = bodyStart;
    let depth = 1;
    let end = html.length;
    let d: RegExpExecArray | null;
    while ((d = divs.exec(html))) {
      if (d[0].startsWith('</')) {
        depth--;
        if (depth === 0) {
          end = d.index;
          break;
        }
      } else {
        depth++;
      }
    }
    out.push({ attrs: parseAttrs(m[0].slice(4, -1)), body: html.slice(bodyStart, end) });
    open.lastIndex = end;
  }
  return out;
}

const SLIDE_SPLIT = /role="cell"\s+class="ds-slider__container__slide"/;

/** Content of a slide cell, i.e. everything after the cell's own opening tag. */
function slideBody(slide: string): string {
  const gt = slide.indexOf('>');
  return gt >= 0 ? slide.slice(gt + 1) : slide;
}

/**
 * Anchors of the financials/general-meetings tables. Each table's first row holds the years;
 * each following row has a rowheader and one slide per year. Every anchor in a slide yields one entry.
 * Relative hrefs are resolved against https://investors.adyen.com.
 */
export function parseFinancialsTables(html: string): TableDoc[] {
  const out: TableDoc[] = [];
  for (const block of tableBlocks(html)) {
    const table = block.attrs['aria-label'] ?? '';
    const rows = block.body.split(/role="row"/).slice(1);
    let years: string[] = [];
    rows.forEach((row, idx) => {
      const parts = row.split(SLIDE_SPLIT);
      const slides = parts.slice(1);
      if (idx === 0) {
        years = slides.map((s) => textOf(slideBody(s).split('</div>')[0]));
        return;
      }
      const rh = /role="rowheader"[^>]*>([\s\S]*?)<\/(?:span|div)>/i.exec(parts[0]);
      const rowName = rh ? textOf(rh[1]) : '';
      slides.forEach((slide, i) => {
        const year = years[i] ?? '';
        if (!/^\d{4}$/.test(year)) return;
        for (const a of anchorsIn(slideBody(slide))) {
          const href = absolutize(a.attrs.href, BASE);
          if (!href) continue;
          const period = (a.attrs['aria-label'] || textOf(a.inner)).trim();
          out.push({ table, row: rowName, year, period, href });
        }
      });
    });
  }
  return out;
}

/** Document links on a page (brand.adyen.com assets, adyen.com DAM files, and .pdf/.xlsx/.zip/.xhtml/.xbrl hrefs). De-duplicated by URL. */
export function parseDocumentLinks(html: string, pageUrl: string): PageDoc[] {
  const seen = new Set<string>();
  const out: PageDoc[] = [];
  for (const a of anchorsIn(html)) {
    const url = absolutize(a.attrs.href, pageUrl);
    if (!url || seen.has(url)) continue;
    const cls = classifyDoc(url);
    if (!cls) continue;
    seen.add(url);
    out.push({
      url,
      id: cls.id,
      kind: cls.kind,
      text: textOf(a.inner),
      ariaLabel: (a.attrs['aria-label'] ?? '').trim(),
      trackTitle: (a.attrs['data-track-title'] ?? '').trim(),
      filename: filenameOf(url),
    });
  }
  return out;
}

/** Content-Disposition filename extension, lower-cased, or ''. */
function extFromDisposition(cd: string | null): string {
  if (!cd) return '';
  const m = /filename\*\s*=\s*(?:UTF-8'')?"?([^";]+)"?/i.exec(cd) ?? /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
  if (!m) return '';
  let name = m[1].trim();
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep raw */
  }
  const e = /\.([a-z0-9]{1,8})$/i.exec(name);
  return e ? e[1].toLowerCase() : '';
}

function extFromUrl(url: string): string {
  const name = filenameOf(url);
  const e = name ? /\.([a-z0-9]{1,8})$/i.exec(name) : null;
  return e ? e[1].toLowerCase() : '';
}

/** Link texts that say nothing about the document ("Download PDF" on stacked list items). */
const GENERIC_LABEL = /^(download(\s+pdf)?|pdf|view|read more|click here|link)$/i;

/** Human label for a document: its own text or aria-label unless generic, then the item's track title, then the filename. */
function docLabel(d: PageDoc): string {
  const specific = [d.text, d.ariaLabel].find((s) => s && !GENERIC_LABEL.test(s));
  return specific || d.trackTitle || d.filename || d.id;
}

// ---------------------------------------------------------------------------
// Press releases (www.adyen.com/press-and-media)
// ---------------------------------------------------------------------------

/** A press release from the press-and-media Nuxt payload. */
export interface PressItem {
  /** Contentful entry id. */
  id: string;
  /** Last path segment of the release URL under /press-and-media/. Unique. */
  slug: string;
  title: string;
  description?: string;
  /** ISO timestamp. For releases older than Sept 2022 this is the CMS import date, not the publication date. */
  firstPublishedAt?: string;
  updatedAt?: string;
}

const PRESS_CONTENT_TYPE = 'pagePressAndMediaDetail';
const DEVALUE_WRAPPERS = new Set(['Reactive', 'ShallowReactive', 'Ref', 'ShallowRef']);

/**
 * String behind a devalue reference. `ref` is an index into the flattened array; a wrapper such as
 * ["Reactive", n] forwards to index n. Numbers, objects, arrays and -1 (undefined) give undefined.
 */
function devalueString(flat: unknown[], ref: unknown, depth = 0): string | undefined {
  if (depth > 4 || typeof ref !== 'number' || !Number.isInteger(ref) || ref < 0 || ref >= flat.length) return undefined;
  const v = flat[ref];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && DEVALUE_WRAPPERS.has(v[0])) {
    return devalueString(flat, v[1], depth + 1);
  }
  return undefined;
}

/**
 * Press releases from `https://www.adyen.com/press-and-media/_payload.json`, a Nuxt devalue payload: a flat
 * array whose objects hold indices into that same array. Returns one item per distinct slug, in payload order.
 */
export function parsePressPayload(json: unknown): PressItem[] {
  if (!Array.isArray(json)) return [];
  const flat: unknown[] = json;
  const bySlug = new Map<string, PressItem>();
  for (const node of flat) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) continue;
    const f = node as Record<string, unknown>;
    if (devalueString(flat, f.contentType) !== PRESS_CONTENT_TYPE) continue;
    const slug = devalueString(flat, f.slug);
    if (!slug || bySlug.has(slug)) continue;
    const item: PressItem = {
      id: devalueString(flat, f.id) ?? '',
      slug,
      title: devalueString(flat, f.title) ?? '',
    };
    const description = devalueString(flat, f.description);
    const firstPublishedAt = devalueString(flat, f.firstPublishedAt);
    const updatedAt = devalueString(flat, f.updatedAt);
    if (description !== undefined) item.description = description;
    if (firstPublishedAt !== undefined) item.firstPublishedAt = firstPublishedAt;
    if (updatedAt !== undefined) item.updatedAt = updatedAt;
    bySlug.set(slug, item);
  }
  return [...bySlug.values()];
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MONTH_ALT = '(January|February|March|April|May|June|July|August|September|October|November|December)';
/** "August 13th, 2026", "August 13, 2026" or "13 August 2026"; ordinal suffix optional. */
const LONG_DATE_RE = new RegExp(
  `\\b(?:${MONTH_ALT}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})|(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_ALT}\\s+(\\d{4}))\\b`,
  'gi',
);

/** First valid long-form date in plain text, as YYYY-MM-DD. */
function firstLongDate(text: string): string | undefined {
  for (const m of text.matchAll(LONG_DATE_RE)) {
    const [month, day, year] = m[1] ? [m[1], m[2], m[3]] : [m[5], m[4], m[6]];
    const mo = MONTH_NAMES.indexOf(month.toLowerCase());
    const d = Number(day);
    const check = new Date(Date.UTC(Number(year), mo, d));
    if (check.getUTCMonth() !== mo || check.getUTCDate() !== d) continue;
    return `${year}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return undefined;
}

/**
 * A press release page: title (the `<title>` without its " - Adyen" suffix), the first long-form date in the
 * main content, the main content's HTML (scripts and styles removed), and the document links inside it.
 */
export function parsePressPage(
  html: string,
  pageUrl: string,
): { title: string; date?: string; contentHtml: string; assets: PageDoc[] } {
  const title = pageTitle(html).replace(/\s+-\s+Adyen\s*$/i, '').trim();
  const body = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
  const contentHtml =
    /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(body)?.[1] ?? /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(body)?.[1] ?? body;
  return {
    title,
    date: firstLongDate(textOf(contentHtml)),
    contentHtml,
    assets: parseDocumentLinks(contentHtml, pageUrl),
  };
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

const BROWSER_HEADERS = {
  'user-agent': USER_AGENT,
  'accept-language': 'en-GB,en;q=0.9',
};

/** GET a page; undefined for a non-200 response. Network errors propagate. */
async function getHtml(url: string, ctx: SourceContext): Promise<string | undefined> {
  const res = await ctx.fetch(url, {
    redirect: 'follow',
    headers: { ...BROWSER_HEADERS, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
  });
  if (res.status !== 200) return undefined;
  return res.text();
}

interface FetchedDoc {
  body: ArrayBuffer | ReadableStream<Uint8Array>;
  contentType: string;
  contentDisposition: string | null;
  /** URL after redirects. */
  finalUrl: string;
  /** From the content type, else the Content-Disposition name (brand assets), else the URL; 'bin' if none. */
  ext: string;
}

/** GET one document. Throws on a non-200 response or a declared size over the limit. The body is streamed. */
async function fetchDocument(url: string, ctx: SourceContext): Promise<FetchedDoc> {
  const res = await ctx.fetch(url, {
    redirect: 'follow',
    headers: { ...BROWSER_HEADERS, accept: '*/*' },
  });
  if (res.status !== 200) throw new Error(`adyen: download ${url} returned ${res.status}`);

  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`adyen: ${url} is ${declared} bytes, over the 100 MB limit`);
  }
  // Stream the body: some documents (videos, iXBRL packs) are far larger than Worker memory.
  const body: ArrayBuffer | ReadableStream<Uint8Array> = res.body ?? (await res.arrayBuffer());

  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  const contentDisposition = res.headers.get('content-disposition');
  const isBrandAsset = /^https?:\/\/brand\.adyen\.com\//i.test(url);
  const finalUrl = res.url || url;
  const ext =
    extFromContentType(contentType, '') ||
    (isBrandAsset ? extFromDisposition(contentDisposition) : '') ||
    extFromUrl(finalUrl) ||
    'bin';
  return { body, contentType, contentDisposition, finalUrl, ext };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * A press release: the page as an HTML object (its date corrects the listing's provisional one), then one object
 * per distinct document linked from the page, up to MAX_PRESS_ASSETS. A document that fails is skipped with a warning.
 */
async function downloadPressRelease(ref: FilingRef, ctx: SourceContext): Promise<StoredObject[]> {
  const res = await ctx.fetch(ref.url, {
    redirect: 'follow',
    headers: { ...BROWSER_HEADERS, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
  });
  if (res.status !== 200) throw new Error(`adyen: press release ${ref.url} returned ${res.status}`);

  const page = parsePressPage(await res.text(), ref.url);
  const title = page.title || ref.title;
  const date = page.date ?? ref.date;
  const stem = `adyen/${ref.ticker}/${yearOf(date)}/${date}_pr_${slugify(title)}`;

  const out: StoredObject[] = [
    {
      key: `${stem}.html`,
      body: `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${page.contentHtml}</body></html>`,
      contentType: 'text/html; charset=utf-8',
      meta: { ...ref, date, title, provisionalDate: page.date === undefined, pageUrl: ref.url },
    },
  ];

  const assets: PageDoc[] = [];
  for (const a of page.assets) {
    if (assets.some((x) => x.id === a.id)) continue;
    assets.push(a);
    if (assets.length === MAX_PRESS_ASSETS) break;
  }
  for (const asset of assets) {
    try {
      const doc = await fetchDocument(asset.url, ctx);
      out.push({
        key: `${stem}_${asset.id}.${doc.ext}`,
        body: doc.body,
        contentType: doc.contentType,
        meta: { ...ref, date, sourceUrl: asset.url, finalUrl: doc.finalUrl, contentType: doc.contentType },
      });
    } catch (err) {
      console.warn(`adyen: press release asset ${asset.url} skipped: ${(err as Error).message}`);
    }
  }
  return out;
}

export const adyenSource: Source = {
  id: 'adyen',
  minDelayMs: 500,
  concurrency: 2,

  async list(holding: Holding, _mode: ListMode, cursor: string | undefined, ctx: SourceContext): Promise<ListPage> {
    // Everything is enumerated in one pass; there is no paging.
    if (cursor !== undefined) return { refs: [] };

    const today = ctx.now().toISOString().slice(0, 10);
    const refs: FilingRef[] = [];
    const seenIds = new Set<string>();
    const add = (ref: FilingRef): void => {
      if (seenIds.has(ref.id)) return;
      seenIds.add(ref.id);
      refs.push(ref);
    };
    const subpages = new Set<string>();

    // 1. Hub pages: table documents first (they carry richer titles), then plain document links.
    for (const path of HUB_PATHS) {
      const hubUrl = BASE + path;
      const html = await getHtml(hubUrl, ctx);
      if (html === undefined) throw new Error(`adyen: hub page ${hubUrl} did not return 200`);

      for (const a of anchorsIn(html)) {
        const key = subpageKey(absolutize(a.attrs.href, hubUrl) ?? '');
        if (key) subpages.add(key);
      }

      const docs = parseDocumentLinks(html, hubUrl);
      const docByUrl = new Map(docs.map((d) => [d.url, d]));

      for (const t of parseFinancialsTables(html)) {
        const cls = classifyDoc(t.href);
        if (!cls) continue;
        const name = t.row || t.table;
        const period = GENERIC_LABEL.test(t.period) ? '' : t.period;
        const title = (period && period !== t.year ? `${name} ${period} ${t.year}` : `${name} ${t.year}`).trim();
        const isH1 = /^H1$/i.test(t.period);
        const anchorText = docByUrl.get(t.href)?.text;
        add({
          source: 'adyen',
          ticker: holding.ticker,
          id: cls.id,
          date: isH1 ? `${t.year}-06-30` : `${t.year}-12-31`,
          title,
          url: t.href,
          extra: {
            pageUrl: hubUrl,
            table: t.table,
            row: t.row,
            period: t.period,
            year: t.year,
            ...(anchorText ? { anchorText } : {}),
          },
        });
      }

      for (const d of docs) {
        const label = docLabel(d);
        const year = findYear([d.text, d.ariaLabel, d.trackTitle, d.filename ?? '']);
        add({
          source: 'adyen',
          ticker: holding.ticker,
          id: d.id,
          date: year ? `${year}-01-01` : today,
          title: label,
          url: d.url,
          extra: {
            pageUrl: hubUrl,
            ...(d.text ? { anchorText: d.text } : {}),
            ...(year ? {} : { dateUnknown: true }),
          },
        });
      }
    }

    // 2. Sub-pages linked from the hubs (one level). A failing sub-page is skipped.
    const subList = [...subpages];
    if (subList.length > MAX_SUBPAGES) {
      console.warn(`adyen: ${subList.length} sub-pages found, crawling the first ${MAX_SUBPAGES}`);
    }
    for (const sub of subList.slice(0, MAX_SUBPAGES)) {
      let html: string | undefined;
      try {
        html = await getHtml(sub, ctx);
      } catch (err) {
        console.warn(`adyen: sub-page ${sub} failed: ${(err as Error).message}`);
        continue;
      }
      if (html === undefined) {
        console.warn(`adyen: sub-page ${sub} skipped (non-200)`);
        continue;
      }

      const title =
        pageTitle(html)
          .replace(/\s+-\s+Adyen\s*$/i, '')
          .trim() || (sub.split('/').pop() ?? sub);

      for (const d of parseDocumentLinks(html, sub)) {
        const label = docLabel(d);
        const year = findYear([title, sub, d.text]);
        add({
          source: 'adyen',
          ticker: holding.ticker,
          id: d.id,
          date: year ? `${year}-01-01` : today,
          title: `${title} – ${label}`,
          url: d.url,
          extra: {
            pageUrl: sub,
            ...(d.text ? { anchorText: d.text } : {}),
            ...(year ? {} : { dateUnknown: true }),
          },
        });
      }
    }

    // 3. Press releases, one ref each, from the press-and-media payload. A failure here loses only these refs.
    try {
      const res = await ctx.fetch(PRESS_PAYLOAD_URL, {
        redirect: 'follow',
        headers: { ...BROWSER_HEADERS, accept: 'application/json,*/*;q=0.8' },
      });
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      const items = parsePressPayload(await res.json());
      if (items.length === 0) throw new Error('no press releases in the payload');
      for (const item of items) {
        const url = PRESS_BASE + item.slug;
        const published = item.firstPublishedAt?.slice(0, 10);
        add({
          source: 'adyen',
          ticker: holding.ticker,
          id: `pr-${item.slug}`,
          date: published && /^\d{4}-\d{2}-\d{2}$/.test(published) ? published : today,
          title: item.title || item.slug,
          form: 'Press release',
          url,
          extra: {
            kind: 'press-release',
            contentfulId: item.id,
            description: item.description,
            provisionalDate: true,
            pageUrl: url,
          },
        });
      }
    } catch (err) {
      console.warn(`adyen: press releases not listed (${PRESS_PAYLOAD_URL}): ${(err as Error).message}`);
    }

    return { refs, nextCursor: undefined };
  },

  async download(ref: FilingRef, ctx: SourceContext): Promise<StoredObject[]> {
    if (ref.extra?.kind === 'press-release') return downloadPressRelease(ref, ctx);

    const doc = await fetchDocument(ref.url, ctx);
    const key = `adyen/${ref.ticker}/${yearOf(ref.date)}/${slugify(ref.title)}_${ref.id}.${doc.ext}`;
    return [
      {
        key,
        body: doc.body,
        contentType: doc.contentType,
        meta: {
          ...ref,
          finalUrl: doc.finalUrl,
          contentType: doc.contentType,
          contentDisposition: doc.contentDisposition,
        },
      },
    ];
  },
};
