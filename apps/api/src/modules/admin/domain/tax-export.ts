// The quarterly tax export's file layout (规划/08 BR-WDR-21; contract adminCreateExport, File; task
// B2-08e). Line one is a note (the creator's account name and the export time), the header follows
// on line two, for this resource only.
//
// Pure module (no decorators, erasable syntax, no clock: instants are passed in).

/** Column order of the contract. Amounts are integer fen, as the two labels say. */
export const TAX_EXPORT_HEADER: readonly string[] = [
  '姓名',
  '证件号',
  '所得类型',
  '收入额（分）',
  '已扣税额（分）',
  '到账时间',
  '收款账户（脱敏）',
  'out_biz_no',
  '到账后实名更正',
];

const FIRST_KEPT = 6;
const LAST_KEPT = 4;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** BR-WDR-21: only the first 6 and the last 4 stay; a shorter value keeps nothing. */
export function maskTaxIdNo(idNo: string): string {
  const kept = FIRST_KEPT + LAST_KEPT;
  if (idNo.length <= kept) return '*'.repeat(idNo.length);
  return `${idNo.slice(0, FIRST_KEPT)}${'*'.repeat(idNo.length - kept)}${idNo.slice(-LAST_KEPT)}`;
}

/** ISO 8601 at +08:00 with milliseconds: the same instant, as the console displays it. */
export function shanghaiInstant(instant: Date): string {
  const shifted = structuredClone(instant);
  shifted.setTime(instant.getTime() + SHANGHAI_OFFSET_MS);
  return `${shifted.toISOString().slice(0, -1)}+08:00`;
}

/** Line one of the file. */
export function taxExportNote(loginName: string, at: Date): string {
  return `导出人：${loginName}；导出时刻：${shanghaiInstant(at)}`;
}
