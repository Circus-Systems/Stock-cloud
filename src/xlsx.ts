/**
 * Minimal, dependency-free reader for .xlsx workbooks.
 *
 * Runs in Cloudflare Workers and Node 22 using only Web APIs
 * (DecompressionStream, Blob, Response, TextDecoder, DataView).
 * XML is scanned with regular expressions; this is sufficient for the
 * well-formed SpreadsheetML that Excel writes, not a general XML parser.
 */

export interface Workbook {
  /** Sheet names in workbook order (hidden sheets included). */
  sheetNames: string[];
  /**
   * Cell values of a named sheet as rows of strings. Row N is at index N-1;
   * missing rows are empty arrays. Rejects if the sheet does not exist.
   */
  sheet(name: string): Promise<string[][]>;
}

interface ZipEntry {
  method: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
}

interface Zip {
  bytes: Uint8Array;
  view: DataView;
  entries: Map<string, ZipEntry>;
}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const ZIP64_32 = 0xffffffff;
const ZIP64_16 = 0xffff;

const utf8 = new TextDecoder('utf-8');

/** Optional namespace prefix, e.g. "x:" in "<x:row>". */
const NS = '(?:[A-Za-z_][\\w.-]*:)?';

// Attribute values are matched lazily up to "/>" or ">" so that self-closing
// elements are not mistaken for opening tags.
const ATTR_RE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ROW_RE = new RegExp(`<${NS}row\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${NS}row\\s*>)`, 'g');
const CELL_RE = new RegExp(`<${NS}c\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${NS}c\\s*>)`, 'g');
const V_RE = new RegExp(`<${NS}v\\b[^>]*?(?:\\/>|>([\\s\\S]*?)<\\/${NS}v\\s*>)`);
const IS_RE = new RegExp(`<${NS}is\\b[^>]*?(?:\\/>|>([\\s\\S]*?)<\\/${NS}is\\s*>)`);
const SI_RE = new RegExp(`<${NS}si\\b[^>]*?(?:\\/>|>([\\s\\S]*?)<\\/${NS}si\\s*>)`, 'g');
const T_RE = new RegExp(`<${NS}t\\b[^>]*?(?:\\/>|>([\\s\\S]*?)<\\/${NS}t\\s*>)`, 'g');
const PH_RE = new RegExp(`<${NS}rPh\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/${NS}rPh\\s*>)`, 'g');
const REL_RE = new RegExp(`<${NS}Relationship\\s([^>]*?)\\/?>`, 'g');
const SHEET_RE = new RegExp(`<${NS}sheet\\s([^>]*?)\\/?>`, 'g');

const ENTITY_RE = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(ENTITY_RE, (match, entity: string) => {
    if (entity.charCodeAt(0) === 35 /* '#' */) {
      const code = entity.charCodeAt(1) === 120 /* 'x' */
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

/** Text content of an XML element: normalise line endings, decode entities. */
function textOf(raw: string): string {
  const s = raw.indexOf('\r') >= 0 ? raw.replace(/\r\n?/g, '\n') : raw;
  return unescapeXml(s);
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR_RE)) {
    out[m[1]!] = unescapeXml(m[2] ?? m[3] ?? '');
  }
  return out;
}

/** Attribute by local name, ignoring any namespace prefix (e.g. "r:id" for "id"). */
function localAttr(attrs: Record<string, string>, local: string): string | undefined {
  if (attrs[local] !== undefined) return attrs[local];
  for (const key of Object.keys(attrs)) {
    if (key.endsWith(':' + local)) return attrs[key];
  }
  return undefined;
}

/** Column letters of a cell reference ("AB12" -> 27). Returns a 0-based index. */
function columnIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i) | 0x20; // lower-case ASCII letter
    if (c < 97 || c > 122) break;
    n = n * 26 + (c - 96);
  }
  if (n === 0) throw new Error(`xlsx: invalid cell reference "${ref}"`);
  return n - 1;
}

/** Resolve a relationship target against the directory of its source part. */
function resolvePart(baseDir: string, target: string): string {
  const path = target.startsWith('/') ? target.slice(1) : baseDir + target;
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

// ---------------------------------------------------------------------------
// ZIP container
// ---------------------------------------------------------------------------

function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
  // The record is 22 bytes plus an optional comment of up to 65535 bytes.
  const lowest = Math.max(0, bytes.length - 22 - 0xffff);
  let first = -1;
  for (let i = bytes.length - 22; i >= lowest; i--) {
    if (view.getUint32(i, true) !== SIG_EOCD) continue;
    // Prefer a candidate whose comment length accounts for the rest of the file.
    if (i + 22 + view.getUint16(i + 20, true) === bytes.length) return i;
    if (first < 0) first = i;
  }
  if (first >= 0) return first;
  throw new Error('xlsx: not a ZIP archive (end of central directory not found)');
}

function openZip(input: ArrayBuffer | Uint8Array): Zip {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes, view);

  const total = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (total === ZIP64_16 || cdSize === ZIP64_32 || cdOffset === ZIP64_32) {
    throw new Error('xlsx: ZIP64 archives are not supported');
  }

  const entries = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== SIG_CEN) {
      throw new Error('xlsx: corrupt ZIP central directory');
    }
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const uncompSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    if (compSize === ZIP64_32 || uncompSize === ZIP64_32 || localOffset === ZIP64_32) {
      throw new Error('xlsx: ZIP64 archives are not supported');
    }
    const nameStart = p + 46;
    const name = utf8.decode(bytes.subarray(nameStart, nameStart + nameLen));
    entries.set(name, { method, compSize, uncompSize, localOffset });
    p = nameStart + nameLen + extraLen + commentLen;
  }
  return { bytes, view, entries };
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readPart(zip: Zip, name: string): Promise<Uint8Array> {
  const entry = zip.entries.get(name);
  if (!entry) throw new Error(`xlsx: missing part "${name}"`);
  const { bytes, view } = zip;

  // Sizes come from the central directory; the local header's own sizes may be zero
  // (data descriptor), so only its name and extra-field lengths are used.
  const lh = entry.localOffset;
  if (lh + 30 > bytes.length || view.getUint32(lh, true) !== SIG_LOC) {
    throw new Error(`xlsx: corrupt local header for "${name}"`);
  }
  const start = lh + 30 + view.getUint16(lh + 26, true) + view.getUint16(lh + 28, true);
  const end = start + entry.compSize;
  if (end > bytes.length) throw new Error(`xlsx: truncated data for "${name}"`);
  const raw = bytes.subarray(start, end);

  let out: Uint8Array;
  if (entry.method === 0) out = raw;
  else if (entry.method === 8) out = await inflateRaw(raw);
  else throw new Error(`xlsx: unsupported compression method ${entry.method} for "${name}"`);

  if (out.length !== entry.uncompSize) {
    throw new Error(`xlsx: size mismatch after decompressing "${name}"`);
  }
  return out;
}

async function readText(zip: Zip, name: string): Promise<string> {
  return utf8.decode(await readPart(zip, name));
}

// ---------------------------------------------------------------------------
// SpreadsheetML
// ---------------------------------------------------------------------------

/** Concatenated text of a rich-text fragment (<si> or <is>), skipping phonetic runs. */
function richText(xml: string): string {
  const body = xml.indexOf('<rPh') >= 0 ? xml.replace(PH_RE, '') : xml;
  let s = '';
  for (const m of body.matchAll(T_RE)) s += textOf(m[1] ?? '');
  return s;
}

async function readSharedStrings(zip: Zip): Promise<string[]> {
  if (!zip.entries.has('xl/sharedStrings.xml')) return [];
  const xml = await readText(zip, 'xl/sharedStrings.xml');
  const strings: string[] = [];
  for (const m of xml.matchAll(SI_RE)) strings.push(richText(m[1] ?? ''));
  return strings;
}

function cellValue(attrs: Record<string, string>, body: string | undefined, sst: string[]): string {
  if (body === undefined || body === '') return '';
  const type = attrs.t ?? 'n';

  if (type === 'inlineStr') {
    const is = IS_RE.exec(body);
    return is ? richText(is[1] ?? '') : '';
  }

  // Formula cells carry their cached result in <v>; a formula with no cache yields ''.
  const v = V_RE.exec(body);
  const raw = v ? textOf(v[1] ?? '') : '';

  switch (type) {
    case 's': {
      if (raw === '') return '';
      const index = Number(raw);
      if (!Number.isInteger(index) || index < 0 || index >= sst.length) {
        throw new Error(`xlsx: shared string index ${raw} out of range`);
      }
      return sst[index]!;
    }
    case 'b':
      return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
    default:
      // 'n', 'str', 'e' (error text), 'd' and anything else: the stored text verbatim.
      return raw;
  }
}

function parseSheet(xml: string, sst: string[]): string[][] {
  const rows: string[][] = [];
  let rowNo = 0;

  for (const rm of xml.matchAll(ROW_RE)) {
    const rowAttrs = parseAttrs(rm[1] ?? '');
    rowNo = rowAttrs.r !== undefined ? parseInt(rowAttrs.r, 10) : rowNo + 1;
    if (!(rowNo >= 1)) throw new Error(`xlsx: invalid row number "${rowAttrs.r}"`);

    const cells: string[] = [];
    let width = 0;
    let nextCol = 0;
    for (const cm of (rm[2] ?? '').matchAll(CELL_RE)) {
      const cellAttrs = parseAttrs(cm[1] ?? '');
      const col = cellAttrs.r !== undefined ? columnIndex(cellAttrs.r) : nextCol;
      nextCol = col + 1;
      const value = cellValue(cellAttrs, cm[2], sst);
      cells[col] = value;
      if (value !== '' && col + 1 > width) width = col + 1;
    }

    const row: string[] = [];
    for (let c = 0; c < width; c++) row.push(cells[c] ?? '');
    while (rows.length < rowNo) rows.push([]);
    rows[rowNo - 1] = row;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function readXlsx(data: ArrayBuffer | Uint8Array): Promise<Workbook> {
  const zip = openZip(data);

  const workbookXml = await readText(zip, 'xl/workbook.xml');
  const relsXml = await readText(zip, 'xl/_rels/workbook.xml.rels');

  const partById = new Map<string, string>();
  for (const m of relsXml.matchAll(REL_RE)) {
    const attrs = parseAttrs(m[1] ?? '');
    if (attrs.Id !== undefined && attrs.Target !== undefined) {
      partById.set(attrs.Id, resolvePart('xl/', attrs.Target));
    }
  }

  const sheets: { name: string; part: string }[] = [];
  for (const m of workbookXml.matchAll(SHEET_RE)) {
    const attrs = parseAttrs(m[1] ?? '');
    const name = attrs.name;
    const rid = localAttr(attrs, 'id');
    if (name === undefined || rid === undefined) continue;
    const part = partById.get(rid);
    if (part === undefined) throw new Error(`xlsx: sheet "${name}" has no relationship ${rid}`);
    sheets.push({ name, part });
  }

  let sharedStrings: Promise<string[]> | undefined;

  return {
    sheetNames: sheets.map((s) => s.name),
    async sheet(name: string): Promise<string[][]> {
      const found = sheets.find((s) => s.name === name);
      if (found === undefined) throw new Error(`xlsx: no sheet named "${name}"`);
      sharedStrings ??= readSharedStrings(zip);
      const [xml, sst] = await Promise.all([readText(zip, found.part), sharedStrings]);
      return parseSheet(xml, sst);
    },
  };
}
