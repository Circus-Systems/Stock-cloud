/**
 * SEC EDGAR source.
 *
 * Listing: https://data.sec.gov/submissions/CIK##########.json holds the most
 * recent 1000 filings under `filings.recent` plus a `filings.files` list of
 * older chunks (same column-array shape at the top level).
 * Documents: https://www.sec.gov/Archives/edgar/data/{cik}/{accessionNoDashes}/{primaryDocument}
 * Filings without a primary document (pre-2001) fall back to the complete
 * submission text file {accession}.txt.
 * SEC fair-access policy: <= 10 requests/second and a descriptive User-Agent.
 */
import type { FilingRef, Holding, ListMode, ListPage, Source, SourceContext, StoredObject } from '../types';
import { extFromContentType, slugify, yearOf } from '../util';

interface SubmissionColumns {
  accessionNumber: string[];
  filingDate: string[];
  reportDate?: string[];
  acceptanceDateTime?: string[];
  act?: string[];
  form: string[];
  fileNumber?: string[];
  filmNumber?: string[];
  items?: string[];
  size?: number[];
  isXBRL?: number[];
  isInlineXBRL?: number[];
  primaryDocument: string[];
  primaryDocDescription?: string[];
}

interface SubmissionsJson {
  cik?: string;
  name?: string;
  filings?: { recent: SubmissionColumns; files?: { name: string; filingCount: number; filingFrom: string; filingTo: string }[] };
}

export function padCik(cik: string): string {
  return String(parseInt(cik, 10)).padStart(10, '0');
}

export function secHeaders(ctx: SourceContext): Record<string, string> {
  return {
    'user-agent': ctx.secUserAgent ?? 'stock-cloud filings-archiver (set SEC_USER_AGENT)',
    accept: '*/*',
    'accept-encoding': 'gzip, deflate',
  };
}

/** Convert the column-array shape into FilingRefs. */
export function columnsToRefs(cols: SubmissionColumns, holding: Holding): FilingRef[] {
  const cik = String(parseInt(holding.cik!, 10));
  const n = cols.accessionNumber.length;
  const refs: FilingRef[] = [];
  for (let i = 0; i < n; i++) {
    const accession = cols.accessionNumber[i];
    const accNoDash = accession.replace(/-/g, '');
    const primary = cols.primaryDocument[i] || '';
    const url = primary
      ? `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDash}/${primary}`
      : `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDash}/${accession}.txt`;
    const acceptance = cols.acceptanceDateTime?.[i];
    refs.push({
      source: 'sec',
      ticker: holding.ticker,
      id: accession,
      date: cols.filingDate[i],
      time: acceptance ? acceptance.slice(11, 16) : undefined,
      title: cols.primaryDocDescription?.[i] || cols.form[i],
      form: cols.form[i],
      url,
      extra: {
        cik,
        accessionNumber: accession,
        reportDate: cols.reportDate?.[i] || undefined,
        acceptanceDateTime: acceptance || undefined,
        act: cols.act?.[i] || undefined,
        fileNumber: cols.fileNumber?.[i] || undefined,
        filmNumber: cols.filmNumber?.[i] || undefined,
        items: cols.items?.[i] || undefined,
        size: cols.size?.[i],
        isXBRL: cols.isXBRL?.[i],
        isInlineXBRL: cols.isInlineXBRL?.[i],
        primaryDocument: primary || undefined,
        primaryDocDescription: cols.primaryDocDescription?.[i] || undefined,
        filingIndex: `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDash}/`,
        fullSubmission: `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDash}/${accession}.txt`,
      },
    });
  }
  return refs;
}

async function fetchJson(url: string, ctx: SourceContext): Promise<unknown> {
  const res = await ctx.fetch(url, { headers: secHeaders(ctx) });
  if (res.status !== 200) throw new Error(`SEC ${url} -> HTTP ${res.status}`);
  return res.json();
}

export const secSource: Source = {
  id: 'sec',
  minDelayMs: 150,
  concurrency: 6,

  async list(holding: Holding, mode: ListMode, cursor: string | undefined, ctx: SourceContext): Promise<ListPage> {
    if (!holding.cik) throw new Error(`holding ${holding.ticker} has no cik`);
    if (cursor === undefined) {
      const url = `https://data.sec.gov/submissions/CIK${padCik(holding.cik)}.json`;
      const data = (await fetchJson(url, ctx)) as SubmissionsJson;
      if (!data.filings?.recent) throw new Error(`SEC submissions for ${holding.ticker}: unexpected shape`);
      const refs = columnsToRefs(data.filings.recent, holding);
      const files = data.filings.files ?? [];
      const nextCursor = mode === 'full' && files.length ? `file:0:${files.map((f) => f.name).join(',')}` : undefined;
      return { refs, nextCursor };
    }
    // cursor = file:{index}:{comma separated names}
    const m = cursor.match(/^file:(\d+):(.*)$/);
    if (!m) throw new Error(`bad sec cursor ${cursor}`);
    const idx = parseInt(m[1], 10);
    const names = m[2].split(',').filter(Boolean);
    const name = names[idx];
    if (!name) return { refs: [] };
    const data = (await fetchJson(`https://data.sec.gov/submissions/${name}`, ctx)) as SubmissionColumns;
    if (!Array.isArray(data.accessionNumber)) throw new Error(`SEC ${name}: unexpected shape`);
    const refs = columnsToRefs(data, holding);
    const nextCursor = idx + 1 < names.length ? `file:${idx + 1}:${names.join(',')}` : undefined;
    return { refs, nextCursor };
  },

  async download(ref: FilingRef, ctx: SourceContext): Promise<StoredObject[]> {
    let res = await ctx.fetch(ref.url, { headers: secHeaders(ctx), redirect: 'follow' });
    let primary = (ref.extra?.primaryDocument as string | undefined) || '';
    const full = ref.extra?.fullSubmission as string | undefined;
    // Some early-2000s filings list a primary document that no longer exists; the complete submission text always does.
    if (res.status === 404 && primary && full) {
      console.warn(`SEC ${ref.url} -> 404, falling back to the complete submission file`);
      res = await ctx.fetch(full, { headers: secHeaders(ctx), redirect: 'follow' });
      primary = '';
    }
    if (res.status !== 200) throw new Error(`SEC ${ref.url} -> HTTP ${res.status}`);
    const body = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const base = primary ? primary.split('/').pop()! : `${ref.id}.txt`;
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    let ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : extFromContentType(contentType, 'txt');
    // XBRL forms rendered through a stylesheet (xslF345X06/form4.xml) come back as HTML.
    if (primary.startsWith('xsl') && /text\/html/i.test(contentType)) ext = 'html';
    const form = slugify(ref.form || 'filing', 20).toUpperCase();
    const key = `sec/${ref.ticker}/${yearOf(ref.date)}/${ref.date}_${ref.id}_${form}_${slugify(stem, 60)}.${ext}`;
    const out: StoredObject[] = [{ key, body, contentType, meta: { ...ref, finalUrl: res.url } }];
    if (ctx.secFullSubmission && primary && full) {
      const r2 = await ctx.fetch(full, { headers: secHeaders(ctx) });
      if (r2.status === 200) {
        out.push({
          key: `sec/${ref.ticker}/${yearOf(ref.date)}/${ref.date}_${ref.id}_${form}_full-submission.txt`,
          body: await r2.arrayBuffer(),
          contentType: 'text/plain; charset=utf-8',
          meta: { ...ref, finalUrl: r2.url, fullSubmission: true },
        });
      } else {
        console.warn(`SEC full submission ${full} -> HTTP ${r2.status}`);
      }
    }
    return out;
  },
};
