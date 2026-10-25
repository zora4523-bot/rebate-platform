// B1-09k (任务书补充 取值 5; B1-09h money r2 S2): which cells of the first sheet of an xlsx are ISO
// date cells (`<c t="d">`). read-excel-file hands both kinds over as the same Date: an ISO date cell
// already holds an absolute instant (with Z or an offset), while a serial date (a number under a
// date format) is a wall clock without a zone. Only the latter is re-read at +08:00, so the sheet
// reader needs to know which is which; this pre-scan tells it. Read-only, no logging.
//   - the zip is read through its central directory (stored or deflated entries; node:zlib);
//   - the first sheet is the first <sheet> of xl/workbook.xml resolved through its relationships
//     (the sheet read-excel-file's readSheet reads by default); xl/worksheets/sheet1.xml when that
//     cannot be resolved;
//   - a cell is addressed by its `r` (A1 style), or by its position in the row when `r` is absent.
// Anything unreadable gives an empty set: read-excel-file decides whether the file is readable.
import { inflateRawSync } from 'node:zlib';

/** "row:column" keys (row 1-based as in the file, column 0-based) of the `t="d"` cells. */
export type IsoDateCells = ReadonlySet<string>;

export const isoDateCellKey = (row: number, column: number): string => `${row}:${column}`;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function entries(buf: Buffer): Map<string, () => Buffer | null> {
  const found = new Map<string, () => Buffer | null>();
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let end = -1;
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) return found;
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  for (let n = 0; n < count; n += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) break;
    const method = buf.readUInt16LE(at + 10);
    const packedSize = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    found.set(name, () => {
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) return null;
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const packed = buf.subarray(start, start + packedSize);
      if (method === 0) return packed;
      return method === 8 ? inflateRawSync(packed) : null;
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return found;
}

const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attributesOf(tag: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of tag.matchAll(ATTRIBUTE)) {
    const name = m[1]!;
    const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
    map.set(name, m[2] ?? m[3] ?? '');
    if (!map.has(local)) map.set(local, m[2] ?? m[3] ?? '');
  }
  return map;
}

function firstSheetPath(read: (name: string) => string | null): string {
  const fallback = 'xl/worksheets/sheet1.xml';
  const workbook = read('xl/workbook.xml');
  const sheet = workbook === null ? null : /<(?:\w+:)?sheet\b([^>]*)>/.exec(workbook);
  const id = sheet === null ? undefined : attributesOf(sheet[1]!).get('id');
  const rels = read('xl/_rels/workbook.xml.rels');
  if (id === undefined || rels === null) return fallback;
  for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b([^>]*)>/g)) {
    const attributes = attributesOf(m[1]!);
    if (attributes.get('Id') !== id) continue;
    const target = attributes.get('Target');
    if (target === undefined) return fallback;
    return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  }
  return fallback;
}

/** Column letters of an A1 reference → 0-based index; null when it is no reference. */
function columnOf(ref: string): number | null {
  const m = /^([A-Z]+)\d*$/i.exec(ref);
  if (m === null) return null;
  let n = 0;
  for (const c of m[1]!.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

function rowOf(ref: string): number | null {
  const m = /^[A-Z]+(\d+)$/i.exec(ref);
  return m === null ? null : Number(m[1]);
}

/** The `t="d"` cells of the first sheet; empty when nothing can be read. */
export function isoDateCells(bytes: Uint8Array): IsoDateCells {
  const cells = new Set<string>();
  try {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const files = entries(buf);
    const read = (name: string): string | null => files.get(name)?.()?.toString('utf8') ?? null;
    const xml = read(firstSheetPath(read));
    if (xml === null) return cells;
    let row = 0;
    let column = -1;
    for (const m of xml.matchAll(/<(?:\w+:)?(row|c)\b([^>]*)>/g)) {
      const attributes = attributesOf(m[2]!);
      const ref = attributes.get('r');
      if (m[1] === 'row') {
        row = ref === undefined ? row + 1 : Number(ref);
        column = -1;
        continue;
      }
      const at = ref === undefined ? null : columnOf(ref);
      column = at ?? column + 1;
      const cellRow = (ref === undefined ? null : rowOf(ref)) ?? row;
      if (attributes.get('t') === 'd') cells.add(isoDateCellKey(cellRow, column));
    }
  } catch {
    cells.clear();
  }
  return cells;
}
