// Rule tests added after the independent review of B2-01a (2026-10-02, round 4): two boundaries
// that only the implementer's unit tests covered. Source: 规划/08 BR-CALC-01 (金额存储为 bigint；
// 契约 int64) and BR-CALC-26 (比例字符串换算为 bp，超界抛 InvalidRatio). Expected values are
// computed by hand from the BR text. Existing test assets are unchanged (规划/11 §4.4).
// Top-level it() only (规划/11 §4.3).
import { InvalidAmount, InvalidRatio, parseFen, pctStrToBp } from '@couli/money';
import { expect, it } from 'vitest';

/** Outcome of one call as a string, so a failure lists every offending input at once. */
function outcome(run: () => bigint): string {
  try {
    return String(run());
  } catch (error) {
    if (error instanceof InvalidAmount) return 'InvalidAmount';
    if (error instanceof InvalidRatio) return 'InvalidRatio';
    return String(error);
  }
}

const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);

it('[BR-CALC-26][BR-CALC-01] parseFen 对 bigint 输入同样守 PG bigint（int64）边界：2^63 与 -(2^63)-1 抛 InvalidAmount，2^63-1 与 -(2^63) 原样返回', () => {
  expect([
    outcome(() => parseFen(2n ** 63n)),
    outcome(() => parseFen(-(2n ** 63n) - 1n)),
    outcome(() => parseFen(INT64_MAX)),
    outcome(() => parseFen(INT64_MIN)),
  ]).toEqual(['InvalidAmount', 'InvalidAmount', '9223372036854775807', '-9223372036854775808']);
});

it("[BR-CALC-26] 百分比超过 100% 哪怕只多在第三位小数也抛 InvalidRatio：pctStrToBp('100.001') 抛错，pctStrToBp('100') → 10000", () => {
  expect([outcome(() => pctStrToBp('100.001')), outcome(() => pctStrToBp('100'))]).toEqual([
    'InvalidRatio',
    '10000',
  ]);
});
