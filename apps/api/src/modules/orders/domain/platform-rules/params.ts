// B1-08za: the order-parameter parsers the per-platform rule tables share (BR-ATTR-06 / 08 / 15).
// Moved here unchanged from domain/attribution.ts and domain/source-backfill.ts so the tables do not
// import the domain code that looks them up; attribution.ts re-exports JD_SUB_UNION and
// parseJsonObject under their old names.

/**
 * BR-ATTR-06 京东 subUnionId：整串完全匹配（JS 的 `$` 不吞结尾换行）。第 1 组 attr_code，第 2 组 link 短码 lk
 * （1–16 位，BR-ATTR-15 exact 用，B1-08j 共用）。
 */
export const JD_SUB_UNION = /^n_([0-9a-z]{8})(?:_([0-9a-z]{1,16}))?$/;

/** BR-ATTR-06 拼多多 uid：8 位 [0-9a-z] 字符串。 */
export const PDD_UID = /^[0-9a-z]{8}$/;

/** BR-ATTR-15 lk：1–16 位 [0-9a-z]（BR-ATTR-06 解析口径，便于将来调长）。 */
export const LINK_CODE = /^[0-9a-z]{1,16}$/;

/** Parses JSON and keeps only a plain object (not null, not an array, not a primitive). */
export function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null || text === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
