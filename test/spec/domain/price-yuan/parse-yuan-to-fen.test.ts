import { parseYuanToFen } from '@couli/domain';
import { yuanStrToFen } from '@couli/money';
import { expect, it } from 'vitest';
import { INT64_MAX, outcomeOf } from './kit.ts';

// Every case goes through outcomeOf so a throw (instead of returning null) fails the assertion.
function returnsNull(inputs: readonly unknown[]): void {
  expect(inputs.map((input) => [input, outcomeOf(input)])).toEqual(
    inputs.map((input) => [input, { returned: null }]),
  );
}

function returnsFen(cases: readonly (readonly [string, bigint])[]): void {
  expect(cases.map(([text]) => [text, outcomeOf(text)])).toEqual(
    cases.map(([text, fen]) => [text, { returned: fen }]),
  );
}

it('[AC-B1-04zi#1] [BR-PRICE-01] 细则「金额解析」原例：39.9 与 39.90 为 3990 分，39.905、空串、-1、abc 为缺失', () => {
  expect([
    parseYuanToFen('39.9'),
    parseYuanToFen('39.90'),
    parseYuanToFen('39.905'),
    parseYuanToFen(''),
    parseYuanToFen('-1'),
    parseYuanToFen('abc'),
  ]).toEqual([3990n, 3990n, null, null, null, null]);
});

it('[AC-B1-04zi#2] [BR-PRICE-01] 整数、一位小数补 0、两位小数按十进制精确换算成 bigint 分', () => {
  returnsFen([
    ['1', 100n],
    ['12', 1200n],
    ['12.3', 1230n],
    ['12.34', 1234n],
    ['0.01', 1n],
    ['0.1', 10n],
    ['0.09', 9n],
    ['0.99', 99n],
    ['19.99', 1999n],
    ['99.9', 9990n],
    ['100.05', 10005n],
    ['123456789.12', 12345678912n],
    ['9007199254740993', 900719925474099300n],
    ['9007199254740993.01', 900719925474099301n],
  ]);
});

it('[AC-B1-04zi#3] [BR-PRICE-01] 0 合法：0、0.0、0.00、00 均为 0n；前导 0 合法', () => {
  returnsFen([
    ['0', 0n],
    ['0.0', 0n],
    ['0.00', 0n],
    ['00', 0n],
    ['000.00', 0n],
    ['007.5', 750n],
    ['01', 100n],
    ['0012.34', 1234n],
    [`${'0'.repeat(64)}1.23`, 123n],
  ]);
});

it('[AC-B1-04zi#4] [BR-PRICE-01] 超过两位小数一律缺失：按字符串数位，不去末尾 0、不四舍五入、不截断', () => {
  returnsNull([
    '39.905',
    '19.999',
    '40.500',
    '1.000',
    '0.000',
    '0.001',
    '0.009',
    '12.340',
    '39.9000',
    '1.005',
    '99.995',
    `1.${'0'.repeat(40)}`,
    '92233720368547758.070',
  ]);
});

it('[AC-B1-04zi#5] [BR-PRICE-01] 负号、正号一律缺失（含 -0 与 -0.00）', () => {
  // Includes U+2212 minus sign and full-width minus / plus.
  returnsNull([
    '-1',
    '-0',
    '-0.00',
    '-39.9',
    '+1',
    '+0',
    '+12.34',
    '--1',
    '1-',
    '1+',
    '−1',
    '－1',
    '＋1',
  ]);
});

it('[AC-B1-04zi#6] [BR-PRICE-01] 前后或中间带空白、换行、不可见字符一律缺失，不做 trim', () => {
  returnsNull([
    ' 1',
    '1 ',
    ' 1 ',
    '1 .2',
    '1. 2',
    '1 2',
    '\t1',
    '1\t',
    '\n1',
    '1\n',
    '1.00\n',
    '1\r',
    '1\r\n',
    ' 1',
    '1 ',
    '1　',
    '\u200B1',
    '1\u200B',
    '\uFEFF1',
    '1\u2028',
    '1\u2029',
    '1\u0000',
    ' ',
  ]);
});

it('[AC-B1-04zi#7] [BR-PRICE-01] 空串、只有点或缺一侧、多个点、千分位与分隔符一律缺失', () => {
  returnsNull([
    '',
    '.',
    '..',
    '.5',
    '.50',
    '5.',
    '12.',
    '1..2',
    '1.2.3',
    '1,000',
    '1,5',
    '1_000',
    "1'000",
    '1。5',
    '1．5',
  ]);
});

it('[AC-B1-04zi#8] [BR-PRICE-01] 指数、十六进制 / 二进制 / 八进制、NaN、Infinity 及字母一律缺失', () => {
  returnsNull([
    '1e2',
    '1E2',
    '1e-2',
    '1.0e1',
    '1.5E+2',
    '0x10',
    '0X1A',
    '0b1',
    '0o7',
    '1n',
    'NaN',
    'Infinity',
    '-Infinity',
    'abc',
    '12a',
    'a12',
    '¥12',
    '12元',
    '$1.00',
  ]);
});

it('[AC-B1-04zi#9] [BR-PRICE-01] 全角数字与其他书写系统的数字一律缺失（只收 ASCII 0-9）', () => {
  returnsNull(['１２', '１', '1２', '１.５０', '12.３', '٣', '۳', '३', '১২', '๑', '𝟏', '①', '一']);
});

it('[AC-B1-04zi#10] [BR-PRICE-01] int64 边界：恰为 9223372036854775807 分合法，多 1 分即缺失', () => {
  expect([
    outcomeOf('92233720368547758.07'),
    outcomeOf('92233720368547758'),
    outcomeOf('00092233720368547758.07'),
    outcomeOf('92233720368547758.06'),
    outcomeOf('92233720368547758.08'),
    outcomeOf('92233720368547758.1'),
    outcomeOf('92233720368547758.99'),
    outcomeOf('92233720368547759'),
    outcomeOf('92233720368547760'),
    outcomeOf('9223372036854775807'),
    outcomeOf('18446744073709551616'),
  ]).toEqual([
    { returned: INT64_MAX },
    { returned: 9223372036854775800n },
    { returned: INT64_MAX },
    { returned: INT64_MAX - 1n },
    { returned: null },
    { returned: null },
    { returned: null },
    { returned: null },
    { returned: null },
    { returned: null },
    { returned: null },
  ]);
});

it('[AC-B1-04zi#11] [BR-PRICE-01] 超长数字串不抛异常，按 int64 判缺失', () => {
  returnsNull(['9'.repeat(20), '9'.repeat(400), `${'9'.repeat(400)}.99`, `1${'0'.repeat(1000)}`]);
});

it('[AC-B1-04zi#12] [BR-PRICE-01] 非字符串输入（number、bigint、null、undefined、对象、数组）返回 null 且不抛异常', () => {
  returnsNull([
    0,
    1,
    39.9,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0n,
    3990n,
    null,
    undefined,
    true,
    false,
    {},
    { toString: () => '1' },
    { valueOf: () => '1' },
    Object('39.9'),
    [],
    ['39.9'],
    [1],
    Symbol('1'),
    () => '1',
  ]);
});

it('[AC-B1-04zi#13] [BR-PRICE-01] 合法结果是 bigint 而不是 number，重复调用结果一致', () => {
  const texts = ['0', '1', '12.3', '12.34', '92233720368547758.07'];
  const first = texts.map((text) => parseYuanToFen(text));
  const second = texts.map((text) => parseYuanToFen(text));
  expect([first.map((value) => typeof value), second]).toEqual([
    texts.map(() => 'bigint'),
    [0n, 100n, 1230n, 1234n, INT64_MAX],
  ]);
});

it('[AC-B1-04zi#14] [BR-PRICE-01] 不复用 yuanStrToFen 的 floor 口径：19.999、40.500 在 money 包可解析，这里是缺失', () => {
  const texts = ['19.999', '40.500', '0.001'];
  expect(texts.map((text) => [outcomeOf(text), yuanStrToFen(text)])).toEqual([
    [{ returned: null }, 1999n],
    [{ returned: null }, 4050n],
    [{ returned: null }, 0n],
  ]);
});
