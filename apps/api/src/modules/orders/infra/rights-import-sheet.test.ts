import { crc32, deflateRawSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { readRightsImportSheet } from './rights-import-sheet.ts';
import { isoDateCellKey, isoDateCells } from './xlsx-date-cells.ts';

/** A plain zip of deflated entries. */
function zip(files: readonly { name: string; data: string }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.data, 'utf8');
    const packed = deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** One sheet: a header, then rows of [text, Excel serial in a date (style 1) cell]. */
function dateSheet(rows: readonly (readonly [string, number])[]): Buffer {
  const body = rows
    .map(
      ([text, serial], i) =>
        `<row r="${i + 2}"><c r="A${i + 2}" t="inlineStr"><is><t>${text}</t></is></c>` +
        `<c r="B${i + 2}" s="1"><v>${serial}</v></c></row>`,
    )
    .join('');
  return zip([
    {
      name: '[Content_Types].xml',
      data:
        `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: `${XML}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        `${XML}<Relationships xmlns="${PKG}">` +
        `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data: `${XML}<styleSheet xmlns="${MAIN}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="22" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data:
        `${XML}<worksheet xmlns="${MAIN}"><sheetData>` +
        '<row r="1"><c r="A1" t="inlineStr"><is><t>relation_id</t></is></c><c r="B1" t="inlineStr"><is><t>end_at</t></is></c></row>' +
        `${body}</sheetData></worksheet>`,
    },
  ]);
}

const at = (iso: string) => Date.parse(iso);

it('[AC-B1-09h#1] a date cell typed as a wall clock comes out as that wall clock at +08:00', async () => {
  // 46326 = 2026-10-31 00:00; .5 = 12:00 the same day (Excel serials, 1900 system).
  const sheet = await readRightsImportSheet(
    new Uint8Array(
      dateSheet([
        ['R8', 46326],
        ['R9', 46326.5],
      ]),
    ),
  );
  expect(sheet?.header).toEqual(['relation_id', 'end_at']);
  const cells = sheet?.rows.map((r) => [r.row_no, r.cells[0], (r.cells[1] as Date).getTime()]);
  expect(cells).toEqual([
    [2, 'R8', at('2026-10-31T00:00:00+08:00')],
    [3, 'R9', at('2026-10-31T12:00:00+08:00')],
  ]);
});

/** A sheet of raw cell XML per data row (style 1 = a date format), header row A1:B1. */
function rawSheet(rows: readonly string[], sheetPath = 'worksheets/sheet1.xml'): Buffer {
  const body = rows.map((cells, i) => `<row r="${i + 2}">${cells}</row>`).join('');
  return zip([
    {
      name: '[Content_Types].xml',
      data:
        `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: `${XML}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        `${XML}<Relationships xmlns="${PKG}">` +
        `<Relationship Id="rId1" Type="${REL}/worksheet" Target="${sheetPath}"/>` +
        `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data: `${XML}<styleSheet xmlns="${MAIN}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="22" applyNumberFormat="1"/></cellXfs></styleSheet>`,
    },
    {
      name: `xl/${sheetPath}`,
      data:
        `${XML}<worksheet xmlns="${MAIN}"><sheetData>` +
        '<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="B1" t="inlineStr"><is><t>b</t></is></c></row>' +
        `${body}</sheetData></worksheet>`,
    },
  ]);
}

it('[AC-B1-09k#9] an ISO date cell (t="d") keeps its instant; a serial date cell is read at +08:00', async () => {
  const sheet = await readRightsImportSheet(
    new Uint8Array(
      rawSheet([
        '<c r="A2" t="d"><v>2026-10-18T02:30:00Z</v></c><c r="B2" s="1"><v>46313.4375</v></c>',
        '<c r="A3" s="1"><v>46313.4375</v></c><c r="B3" s="1" t="d"><v>2026-10-18T10:30:00+08:00</v></c>',
      ]),
    ),
  );
  const times = sheet?.rows.map((r) => r.cells.map((c) => (c as Date).getTime()));
  const want = at('2026-10-18T02:30:00Z');
  expect(times).toEqual([
    [want, want],
    [want, want],
  ]);
});

it('[AC-B1-09k#9] the first sheet is found through the workbook relationships; cells without r by position', async () => {
  const bytes = rawSheet(
    ['<c s="1"><v>46313.4375</v></c><c t="d"><v>2026-10-18T02:30:00Z</v></c>'],
    'worksheets/other.xml',
  );
  expect([...isoDateCells(new Uint8Array(bytes))]).toEqual([isoDateCellKey(2, 1)]);
});

it('[AC-B1-09k#9] not a zip → no ISO date cells', () => {
  expect(isoDateCells(new Uint8Array(Buffer.from('not a zip'))).size).toBe(0);
});
