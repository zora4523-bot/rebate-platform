import { formatYuanRange } from '@couli/money';
import { expect, it } from 'vitest';

it.each([
  [320n, 450n, '¥3.2–¥4.5'],
  [450n, 450n, '¥4.5'],
  [0n, 0n, null],
  [0n, 1n, '¥0–¥0.01'],
  [1n, 1n, '¥0.01'],
  [99999n, 100000n, '¥999.99–¥1000'],
  [9007199254740992n, 9007199254740993n, '¥90071992547409.92–¥90071992547409.93'],
  [9223372036854775807n, 9223372036854775807n, '¥92233720368547758.07'],
] as const)('[AC-F1-06d#5][BR-TEXT-10] App 返利区间 %s / %s → %s', (min, max, expected) => {
  expect(formatYuanRange(min, max)).toBe(expected);
});

it.each([
  [320n, 450n, '¥3.20–¥4.50'],
  [450n, 450n, '¥4.50'],
  [0n, 0n, null],
  [0n, 1n, '¥0.00–¥0.01'],
  [1n, 1n, '¥0.01'],
  [99999n, 100000n, '¥999.99–¥1,000.00'],
  [123456n, 2000000n, '¥1,234.56–¥20,000.00'],
  [
    9223372036854775806n,
    9223372036854775807n,
    '¥92,233,720,368,547,758.06–¥92,233,720,368,547,758.07',
  ],
  [9223372036854775807n, 9223372036854775807n, '¥92,233,720,368,547,758.07'],
] as const)('[AC-F1-06d#6][BR-TEXT-10] 后台返利区间 %s / %s → %s', (min, max, expected) => {
  expect(formatYuanRange(min, max, { admin: true })).toBe(expected);
});

it.each([{}, { admin: false }])(
  '[AC-F1-06d#7][BR-TEXT-10] 未开启 admin 使用 App 区间格式（%s）',
  (opts) => {
    expect(formatYuanRange(990n, 123456n, opts)).toBe('¥9.9–¥1234.56');
  },
);
