// B1-22r / orchestrator ruling D10-427 ①, SPEC_REF 37808a5: the optional reason of union's admin
// writes with a Unicode Cc control character is 20001 [reason]; nothing is written, audited or
// sent out. Shared values of the rule tests in this directory.

/** Every Unicode Cc code point: U+0000–U+001F and U+007F–U+009F. */
export const CC_CODE_POINTS: readonly number[] = [
  ...Array.from({ length: 0x20 }, (_v, i) => i),
  ...Array.from({ length: 0x21 }, (_v, i) => 0x7f + i),
];

/** The four control characters the ruling names. */
export const NAMED_CONTROLS = ['\n', '\t', '\u0000', '\u007f'] as const;

/**
 * Reasons that pass the route schema (1–200 characters) but carry a control character: each named
 * one in the middle, at the start and at the end, and one 200 characters long.
 */
export function controlReasons(): string[] {
  const out: string[] = [];
  for (const control of NAMED_CONTROLS) {
    out.push(`更换原因${control}第二行`, `${control}更换原因`, `更换原因${control}`);
  }
  out.push(`${'因'.repeat(199)}\n`);
  return out;
}

/** Valid reasons that must keep working: the 200-character boundary, Chinese, spaces, symbols. */
export const VALID_REASONS: readonly string[] = [
  '因',
  '续'.repeat(200),
  '到期前 提前 续期',
  ' 前后有空格 ',
  'Renew before expiry (ticket #42) – 运营确认',
  '零宽\u200B空格与\u2028行分隔不是 Cc',
];

/** JSON text of a reason as a test title shows it (control characters escaped). */
export const shown = (reason: string) => JSON.stringify(reason);
