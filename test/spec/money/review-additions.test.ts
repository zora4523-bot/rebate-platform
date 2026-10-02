// Rule tests added after the first Claude money review of B2-01a (规划/11 §4.4: test assets
// are only added, never changed). Sources: 规划/08 BR-CALC-01 (金额以整数分存储与运算，PG
// bigint；契约 int64；需要向上取整的场景用 mulDivCeil，同样只接受非负数) and BR-CALC-26
// (pctStrToBp 按十进制字符串换算为 bp，超过 2 位小数 floor；非法格式抛错，不得按 0 处理).
// Top-level it() only (规划/11 §4.3).
import {
  InvalidAmount,
  InvalidRatio,
  mulDivCeil,
  parseFen,
  pctStrToBp,
  yuanStrToFen,
} from '@couli/money';
import { expect, it } from 'vitest';

const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;

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

it('[BR-CALC-01] PG bigint 边界内的金额照常解析：parseFen 与 yuanStrToFen 都接受 int64 的最大值和最小值', () => {
  expect([
    parseFen('9223372036854775807'),
    parseFen('-9223372036854775808'),
    yuanStrToFen('92233720368547758.07'),
    yuanStrToFen('-92233720368547758.08'),
  ]).toEqual([INT64_MAX, INT64_MIN, INT64_MAX, INT64_MIN]);
});

it('[BR-CALC-01] 超出 PG bigint（int64）范围的金额字符串在解析时抛 InvalidAmount，不留到写库时才失败', () => {
  const inputs: Array<[string, () => bigint]> = [
    ["yuanStrToFen('92233720368547758.08')", () => yuanStrToFen('92233720368547758.08')],
    ["yuanStrToFen('-92233720368547758.09')", () => yuanStrToFen('-92233720368547758.09')],
    // floor of a negative value with a tail goes one fen further down, past INT64_MIN.
    ["yuanStrToFen('-92233720368547758.081')", () => yuanStrToFen('-92233720368547758.081')],
    ["yuanStrToFen('1'.repeat(30))", () => yuanStrToFen('1'.repeat(30))],
    ["parseFen('9223372036854775808')", () => parseFen('9223372036854775808')],
    ["parseFen('-9223372036854775809')", () => parseFen('-9223372036854775809')],
    ["parseFen('1'.repeat(50))", () => parseFen('1'.repeat(50))],
  ];
  const got = inputs.map(([label, run]) => [label, outcome(run)]);
  expect(got).toEqual(inputs.map(([label]) => [label, 'InvalidAmount']));
});

it('[BR-CALC-01] mulDivCeil 先乘后除再向上取整：(101, 5000, 10000) → 51；整除时不多进 1', () => {
  expect([
    mulDivCeil(101n, 5000n, 10000n),
    mulDivCeil(100n, 5000n, 10000n),
    mulDivCeil(1n, 1n, 10000n),
    mulDivCeil(0n, 10000n, 10000n),
    mulDivCeil(9999n, 10000n, 10000n),
  ]).toEqual([51n, 50n, 1n, 0n, 9999n]);
});

it('[BR-CALC-01] mulDivCeil 只接受非负金额与 0–10000 的比例：负金额抛 InvalidAmount，比例越界抛 InvalidRatio', () => {
  expect([
    outcome(() => mulDivCeil(-1n, 5000n, 10000n)),
    outcome(() => mulDivCeil(100n, 10001n, 10000n)),
    outcome(() => mulDivCeil(100n, -1n, 10000n)),
  ]).toEqual(['InvalidAmount', 'InvalidRatio', 'InvalidRatio']);
});

it("[BR-CALC-26] 百分比字符串按十进制换算为 bp：'20.00' → 2000，'15' → 1500，'0.015' → 1（floor），'100' → 10000", () => {
  expect([pctStrToBp('20.00'), pctStrToBp('15'), pctStrToBp('0.015'), pctStrToBp('100')]).toEqual([
    2000n,
    1500n,
    1n,
    10000n,
  ]);
});

it('[BR-CALC-26] 非法百分比字符串（空串、非数字、科学计数法、超过 100%）抛错，不得按 0 处理', () => {
  const bad = ['', 'abc', '1e2', 'NaN', '100.01', '101'];
  const got = bad.map((text) => outcome(() => pctStrToBp(text)));
  expect(got).toEqual(bad.map(() => 'InvalidRatio'));
});
