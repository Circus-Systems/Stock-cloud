/** Small helpers shared by sources: slugs, HTML entity decoding, date parsing. */

export function slugify(s: string, max = 80): string {
  const out = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return out.slice(0, max).replace(/-+$/g, '') || 'untitled';
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#x2F': '/', '#47': '/',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', pound: '£', euro: '€', copy: '©', reg: '®', trade: '™',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ent: string) => {
    if (ent in ENTITIES) return ENTITIES[ent];
    if (ent.startsWith('#x')) return String.fromCodePoint(parseInt(ent.slice(2), 16));
    if (ent.startsWith('#')) return String.fromCodePoint(parseInt(ent.slice(1), 10));
    return m;
  });
}

/** Strip tags and collapse whitespace. */
export function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** "18/12/2024" -> "2024-12-18" */
export function dmyToIso(dmy: string): string {
  const m = dmy.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) throw new Error(`bad d/m/y date: ${dmy}`);
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** "4:51 pm" -> "16:51"; "09:21 AM" -> "09:21"; "17:11" -> "17:11" */
export function to24h(t: string): string | undefined {
  const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*([aApP][mM])?$/);
  if (!m) return undefined;
  let h = parseInt(m[1], 10);
  const ampm = m[3]?.toLowerCase();
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

export function yearOf(isoDate: string): string {
  return isoDate.slice(0, 4);
}

export function extFromContentType(ct: string | null | undefined, fallback = 'bin'): string {
  if (!ct) return fallback;
  const t = ct.split(';')[0].trim().toLowerCase();
  const map: Record<string, string> = {
    'application/pdf': 'pdf', 'text/html': 'html', 'text/plain': 'txt', 'application/xml': 'xml', 'text/xml': 'xml',
    'application/json': 'json', 'application/zip': 'zip', 'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  };
  return map[t] ?? fallback;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function sha1Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
