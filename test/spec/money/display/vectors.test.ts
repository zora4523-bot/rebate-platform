// BR-TEXT-10 task vectors. AC-F1-06d labels are local test identifiers, not new business ACs.
// The denomination vector (550 -> '5.5 元') is explicitly outside this task's scope.
import { formatYuan, formatYuanAdmin } from '@couli/money';
import { expect, it } from 'vitest';

it.each([
  [990n, '¥9.9'],
  [1000n, '¥10'],
  [1n, '¥0.01'],
  [0n, '¥0'],
  [123456n, '¥1234.56'],
  [-150n, '-¥1.5'],
  [10n, '¥0.1'],
  [101n, '¥1.01'],
  [110n, '¥1.1'],
  [99999n, '¥999.99'],
  [100000n, '¥1000'],
  [-1n, '-¥0.01'],
  [-100n, '-¥1'],
  [9007199254740993n, '¥90071992547409.93'],
  [9223372036854775807n, '¥92233720368547758.07'],
  [-9223372036854775808n, '-¥92233720368547758.08'],
] as const)('[AC-F1-06d#1][BR-TEXT-10] App %s 分 → %s', (fen, expected) => {
  expect(formatYuan(fen)).toBe(expected);
});

it.each([
  [2000000n, '¥20,000.00'],
  [123456n, '¥1,234.56'],
  [990n, '¥9.90'],
  [1n, '¥0.01'],
  [0n, '¥0.00'],
  [-120n, '-¥1.20'],
  [123456789n, '¥1,234,567.89'],
  [99999n, '¥999.99'],
  [100000n, '¥1,000.00'],
  [99999999n, '¥999,999.99'],
  [100000000n, '¥1,000,000.00'],
  [-1n, '-¥0.01'],
  [-123456789n, '-¥1,234,567.89'],
  [9007199254740993n, '¥90,071,992,547,409.93'],
  [9223372036854775807n, '¥92,233,720,368,547,758.07'],
  [-9223372036854775808n, '-¥92,233,720,368,547,758.08'],
] as const)('[AC-F1-06d#2][BR-TEXT-10] 后台 %s 分 → %s', (fen, expected) => {
  expect(formatYuanAdmin(fen)).toBe(expected);
});

it.each([
  [600n, '+¥6', '+¥6.00'],
  [1n, '+¥0.01', '+¥0.01'],
  [0n, '¥0', '¥0.00'],
  [-120n, '-¥1.2', '-¥1.20'],
  [-1n, '-¥0.01', '-¥0.01'],
  [123456n, '+¥1234.56', '+¥1,234.56'],
] as const)('[AC-F1-06d#3][BR-TEXT-10] 流水 %s 分的符号位于 ¥ 前', (fen, app, admin) => {
  expect([formatYuan(fen, { signed: true }), formatYuanAdmin(fen, { signed: true })]).toEqual([
    app,
    admin,
  ]);
});

it.each([undefined, {}, { signed: false }])(
  '[AC-F1-06d#4][BR-TEXT-10] 未开启 signed 时正数不带 +（%s）',
  (opts) => {
    expect([formatYuan(600n, opts), formatYuanAdmin(600n, opts)]).toEqual(['¥6', '¥6.00']);
  },
);
