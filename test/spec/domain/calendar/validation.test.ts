import { accountingDate, chinaDayRange, chinaMonth, chinaMonthRange } from '@couli/domain';
import { expect, it } from 'vitest';

it.each([NaN, Infinity, -Infinity, 8_640_000_000_000_001])(
  '[AC-B1-08d#9] accountingDate 拒绝非法 Date（%s），抛 RangeError',
  (value) => {
    expect(() => accountingDate(new Date(value))).toThrow(RangeError);
  },
);

it.each([NaN, Infinity, -Infinity, 8_640_000_000_000_001])(
  '[AC-B1-08d#10] chinaMonth 拒绝非法 Date（%s），抛 RangeError',
  (value) => {
    expect(() => chinaMonth(new Date(value))).toThrow(RangeError);
  },
);

it.each([
  '',
  '2026',
  '2026-10',
  '26-10-20',
  '2026-1-20',
  '2026-10-2',
  '2026/10/20',
  '2026.10.20',
  '20261020',
  '2026-10-20T00:00:00+08:00',
  ' 2026-10-20',
  '2026-10-20 ',
  '2026-10-20\n',
  '2026-10-20junk',
  '２０２６-１０-２０',
  '+2026-10-20',
  '2026-00-20',
  '2026-13-20',
  '2026-10-00',
  '2026-10-32',
  '2026-04-31',
  '2026-06-31',
  '2026-09-31',
  '2026-11-31',
  '2026-02-29',
  '2026-02-30',
  '2024-02-30',
  '1900-02-29',
  '2100-02-29',
])('[AC-B1-08d#11] chinaDayRange 严格拒绝格式错误或不存在的日期 %j', (date) => {
  expect(() => chinaDayRange(date)).toThrow(RangeError);
});

it.each([
  '',
  '2026',
  '26-10',
  '2026-1',
  '2026-001',
  '2026/10',
  '2026.10',
  '202610',
  '2026-10-01',
  '2026-10T00:00:00Z',
  ' 2026-10',
  '2026-10 ',
  '2026-10\n',
  '2026-10junk',
  '２０２６-１０',
  '+2026-10',
  '2026-00',
  '2026-13',
  '2026--1',
])('[AC-B1-08d#12] chinaMonthRange 严格拒绝格式错误或不存在的月份 %j', (month) => {
  expect(() => chinaMonthRange(month)).toThrow(RangeError);
});
