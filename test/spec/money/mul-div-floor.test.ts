// Rule tests for mulDivFloor (规划/08 BR-CALC-01, BR-CALC-08, worked examples of BR-CALC-02 /
// BR-CALC-04). Every expected value is copied from the 08 text at SPEC_REF; top-level it() only
// (规划/11 §4.3); @couli/money is never mocked.
import { InvalidAmount, InvalidRatio, mulDivFloor } from '@couli/money';
import { expect, it } from 'vitest';

it('[BR-CALC-01] 例：B=1234、r=5000 → 1234n*5000n/10000n = 617n', () => {
  expect(mulDivFloor(1234n, 5000n, 10000n)).toBe(617n);
});

it('[BR-CALC-08] 例：B=1235、5000/1000 → 617.5→617、123.5→123（向下取整，不四舍五入）', () => {
  expect([mulDivFloor(1235n, 5000n, 10000n), mulDivFloor(1235n, 1000n, 10000n)]).toEqual([
    617n,
    123n,
  ]);
});

it('[BR-CALC-08] 例：B=9、5000/1000 → 4、0', () => {
  expect([mulDivFloor(9n, 5000n, 10000n), mulDivFloor(9n, 1000n, 10000n)]).toEqual([4n, 0n]);
});

it('[BR-CALC-02] 例（尾差）：floor(1452×8500/10000)=floor(1234.2)=1234', () => {
  expect(mulDivFloor(1452n, 8500n, 10000n)).toBe(1234n);
});

it('[BR-CALC-04] 例 4：B=850，本人 5000 → 425，直推 1000 → 85，L3 本人 6500 → 552，间推 500 → floor(42.5)=42', () => {
  expect([
    mulDivFloor(850n, 5000n, 10000n),
    mulDivFloor(850n, 1000n, 10000n),
    mulDivFloor(850n, 6500n, 10000n),
    mulDivFloor(850n, 500n, 10000n),
  ]).toEqual([425n, 85n, 552n, 42n]);
});

it('[BR-CALC-04] 例 3：B=1、5000/1000 → 0、0', () => {
  expect([mulDivFloor(1n, 5000n, 10000n), mulDivFloor(1n, 1000n, 10000n)]).toEqual([0n, 0n]);
});

it('[BR-CALC-01] 边界：ratio 0 → 0，ratio 10000 → 原额（_bp 取值 0–10000）', () => {
  expect([mulDivFloor(1234n, 0n, 10000n), mulDivFloor(1234n, 10000n, 10000n)]).toEqual([0n, 1234n]);
});

it('[BR-CALC-01] 先乘后除：超过 2^53 的金额仍逐分精确（9007199254740993 × 5000 / 10000 = 4503599627370496）', () => {
  expect(mulDivFloor(9007199254740993n, 5000n, 10000n)).toBe(4503599627370496n);
});

it('[BR-CALC-01] 只接受 amount_fen ≥ 0：-101n 抛 InvalidAmount（不得返回截断的 -50n）', () => {
  expect(() => mulDivFloor(-101n, 5000n, 10000n)).toThrow(InvalidAmount);
});

it('[BR-CALC-01] 金额不是 bigint（number 1234、浮点 12.34）抛 InvalidAmount', () => {
  const asBigint = (v: unknown): bigint => v as bigint;
  expect(() => mulDivFloor(asBigint(1234), 5000n, 10000n)).toThrow(InvalidAmount);
  expect(() => mulDivFloor(asBigint(12.34), 5000n, 10000n)).toThrow(InvalidAmount);
});

it('[BR-CALC-01] _bp 超界（-1、10001）抛 InvalidRatio，不得静默截断', () => {
  expect(() => mulDivFloor(1234n, -1n, 10000n)).toThrow(InvalidRatio);
  expect(() => mulDivFloor(1234n, 10001n, 10000n)).toThrow(InvalidRatio);
});

it('[BR-CALC-01] _bp 非整数或不是 bigint（0.5、5000 的 number）抛 InvalidRatio，禁止先把 bp 转成小数', () => {
  const asBigint = (v: unknown): bigint => v as bigint;
  expect(() => mulDivFloor(1234n, asBigint(0.5), 10000n)).toThrow(InvalidRatio);
  expect(() => mulDivFloor(1234n, asBigint(5000), 10000n)).toThrow(InvalidRatio);
});
