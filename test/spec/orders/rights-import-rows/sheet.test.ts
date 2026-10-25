// 共用读表器的时间单元格（任务书补充 取值 5；B1-09h money 评审 r2 的 S2）：xlsx 的 ISO 日期格（t="d"）存的是
// 带 Z 或偏移的绝对时刻，照原时刻读出、不再减 8 小时；Excel 序列号日期格（数字 + 日期格式）是没有时区的墙上
// 时间，仍按 +08:00 读（B1-09h r1）。不连库。用例全部是顶层 it（规划/11 §4.3）。
import { expect, it } from 'vitest';
import { readRightsImportSheet } from '../../../../apps/api/src/modules/orders/infra/rights-import-sheet.ts';
import { zip } from '../rights-import-task/kit.ts';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

const text = (value: string) => Buffer.from(value, 'utf8');

/** One sheet: header A1..C1, then the given raw cell XML per row (style 1 = a date format). */
function book(rows: readonly string[]): Buffer {
  const body = rows.map((cells, i) => `<row r="${i + 2}">${cells}</row>`).join('');
  return zip([
    {
      name: '[Content_Types].xml',
      data: text(
        `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/></Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: text(
        `${XML}<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: text(
        `${XML}<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: text(
        `${XML}<Relationships xmlns="${PKG}">` +
          `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
          `<Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
      ),
    },
    {
      name: 'xl/styles.xml',
      data: text(
        `${XML}<styleSheet xmlns="${MAIN}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="22" applyNumberFormat="1"/></cellXfs></styleSheet>`,
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: text(
        `${XML}<worksheet xmlns="${MAIN}"><sheetData>` +
          '<row r="1"><c r="A1" t="inlineStr"><is><t>iso_z</t></is></c>' +
          '<c r="B1" t="inlineStr"><is><t>iso_offset</t></is></c>' +
          '<c r="C1" t="inlineStr"><is><t>serial</t></is></c></row>' +
          `${body}</sheetData></worksheet>`,
      ),
    },
  ]);
}

const ms = (iso: string) => Date.parse(iso);
const times = (cells: readonly unknown[]) =>
  cells.map((cell) => (cell instanceof Date ? cell.getTime() : cell));

it('[AC-B1-09k#9] ISO 日期格（t="d"，带 Z 或偏移）照原时刻读出、不减 8 小时；序列号日期格仍按 +08:00 的墙上时间', async () => {
  // 46313.4375 = 2026-10-18 10:30（Excel 1900 序列号），按 +08:00 即 02:30Z；两个 t="d" 格是同一绝对时刻。
  const sheet = await readRightsImportSheet(
    new Uint8Array(
      book([
        '<c r="A2" t="d"><v>2026-10-18T02:30:00Z</v></c>' +
          '<c r="B2" t="d"><v>2026-10-18T10:30:00+08:00</v></c>' +
          '<c r="C2" s="1"><v>46313.4375</v></c>',
        '<c r="A3" s="1" t="d"><v>2026-10-31T16:00:00.000Z</v></c>' +
          '<c r="B3" s="1" t="d"><v>2026-11-01T00:00:00+08:00</v></c>' +
          '<c r="C3" s="1"><v>46327</v></c>',
      ]),
    ),
  );
  expect(sheet?.header).toEqual(['iso_z', 'iso_offset', 'serial']);
  expect(sheet?.rows.map((r) => [r.row_no, ...times(r.cells)])).toEqual([
    [2, ms('2026-10-18T02:30:00Z'), ms('2026-10-18T02:30:00Z'), ms('2026-10-18T02:30:00Z')],
    [3, ms('2026-10-31T16:00:00Z'), ms('2026-10-31T16:00:00Z'), ms('2026-10-31T16:00:00Z')],
  ]);
});
