// Rule tests for amount parsing, formatting and JSON serialization (规划/08 BR-CALC-01 整数分、
// 序列化不超过 2^53−1; BR-CALC-26 元字符串换算). Top-level it() only (规划/11 §4.3).
import { fenToJsonNumber, formatFen, InvalidAmount, parseFen, yuanStrToFen } from '@couli/money';
import { expect, it } from 'vitest';

const asAny = (v: unknown): never => v as never;

it("[BR-CALC-26] 例：'14.52' → 1452；'14.5' → 1450；'14.526' → 1452（floor）；'-3.20' → -320", () => {
  expect([
    yuanStrToFen('14.52'),
    yuanStrToFen('14.5'),
    yuanStrToFen('14.526'),
    yuanStrToFen('-3.20'),
  ]).toEqual([1452n, 1450n, 1452n, -320n]);
});

it("[BR-CALC-26] 例：JSON 原文 0.1 的字面值 '0.1' → 10，不经过二进制浮点", () => {
  expect(yuanStrToFen('0.1')).toBe(10n);
});

it("[BR-CALC-26] 小数不超过 2 位时精确换算：'14' → 1400，'0.05' → 5，'0' → 0", () => {
  expect([yuanStrToFen('14'), yuanStrToFen('0.05'), yuanStrToFen('0')]).toEqual([1400n, 5n, 0n]);
});

it("[BR-CALC-26] 超过 2 位小数按 floor：'0.019' → 1，'99.999' → 9999", () => {
  expect([yuanStrToFen('0.019'), yuanStrToFen('99.999')]).toEqual([1n, 9999n]);
});

it("[BR-CALC-26] 超过 2^53 的元字符串逐分精确：'92233720368547758.07' → 9223372036854775807", () => {
  expect(yuanStrToFen('92233720368547758.07')).toBe(9223372036854775807n);
});

it('[BR-CALC-26] 非法格式（空串、非数字、科学计数法、NaN、Infinity、多个小数点）抛 InvalidAmount，不得按 0 处理', () => {
  const bad = ['', 'abc', '1e3', '1E-2', 'NaN', 'Infinity', '1.2.3', '-'];
  const outcomes = bad.map((text) => {
    try {
      return { text, result: String(yuanStrToFen(text)) };
    } catch (error) {
      return { text, result: error instanceof InvalidAmount ? 'InvalidAmount' : String(error) };
    }
  });
  expect(outcomes).toEqual(bad.map((text) => ({ text, result: 'InvalidAmount' })));
});

it('[BR-CALC-26] 参数不是字符串（JS number 14.52）抛 InvalidAmount，禁止 parseFloat 与 Number 运算', () => {
  expect(() => yuanStrToFen(asAny(14.52))).toThrow(InvalidAmount);
});

it('[BR-CALC-01] parseFen：bigint 原样返回，安全整数 number 与十进制整数字符串换成 bigint', () => {
  expect([
    parseFen(1452n),
    parseFen(-320n),
    parseFen(1452),
    parseFen(0),
    parseFen('1452'),
    parseFen('-320'),
    parseFen('9007199254740993'),
  ]).toEqual([1452n, -320n, 1452n, 0n, 1452n, -320n, 9007199254740993n]);
});

it('[BR-CALC-01] parseFen：浮点、NaN、Infinity、超过 2^53−1 的 number 抛 InvalidAmount（金额禁止 number 浮点）', () => {
  const bad: unknown[] = [12.34, 0.1, Number.NaN, Number.POSITIVE_INFINITY, -Infinity, 2 ** 53];
  const outcomes = bad.map((value) => {
    try {
      return String(parseFen(value));
    } catch (error) {
      return error instanceof InvalidAmount ? 'InvalidAmount' : String(error);
    }
  });
  expect(outcomes).toEqual(bad.map(() => 'InvalidAmount'));
});

it('[BR-CALC-01] parseFen：非整数字符串与其他类型抛 InvalidAmount', () => {
  const bad: unknown[] = [
    '',
    '12.34',
    '1e3',
    '0x10',
    ' 12',
    'NaN',
    'abc',
    null,
    undefined,
    true,
    {},
    [1],
  ];
  const outcomes = bad.map((value) => {
    try {
      return String(parseFen(value));
    } catch (error) {
      return error instanceof InvalidAmount ? 'InvalidAmount' : String(error);
    }
  });
  expect(outcomes).toEqual(bad.map(() => 'InvalidAmount'));
});

it("[BR-CALC-01] formatFen：展示层除以 100，固定两位小数（1452 → '14.52'，-320 → '-3.20'）", () => {
  expect([
    formatFen(1452n),
    formatFen(1450n),
    formatFen(5n),
    formatFen(0n),
    formatFen(-320n),
    formatFen(-5n),
    formatFen(9223372036854775807n),
  ]).toEqual(['14.52', '14.50', '0.05', '0.00', '-3.20', '-0.05', '92233720368547758.07']);
});

it('[BR-CALC-01] formatFen：参数不是 bigint（number 1452）抛 InvalidAmount', () => {
  expect(() => formatFen(asAny(1452))).toThrow(InvalidAmount);
});

it('[BR-CALC-01] 序列化：|金额| ≤ 2^53−1 转成 JSON 整数', () => {
  expect([
    fenToJsonNumber(1452n),
    fenToJsonNumber(-320n),
    fenToJsonNumber(9007199254740991n),
    fenToJsonNumber(-9007199254740991n),
  ]).toEqual([1452, -320, 9007199254740991, -9007199254740991]);
});

it('[BR-CALC-01] 序列化：超过 2^53−1 时抛错，不得静默丢精度', () => {
  expect(() => fenToJsonNumber(9007199254740992n)).toThrow(InvalidAmount);
  expect(() => fenToJsonNumber(-9007199254740992n)).toThrow(InvalidAmount);
});

it('[BR-CALC-01] 序列化：参数不是 bigint（number 1452）抛 InvalidAmount', () => {
  expect(() => fenToJsonNumber(asAny(1452))).toThrow(InvalidAmount);
});
