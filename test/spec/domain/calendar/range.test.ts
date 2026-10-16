import { chinaDate, chinaDayRange, chinaMonth, chinaMonthRange } from '@couli/domain';
import { expect, it } from 'vitest';

const days = [
  ['2026-10-20', '2026-10-19T16:00:00.000Z', '2026-10-20T16:00:00.000Z', '2026-10-21'],
  ['2026-10-31', '2026-10-30T16:00:00.000Z', '2026-10-31T16:00:00.000Z', '2026-11-01'],
  ['2026-12-31', '2026-12-30T16:00:00.000Z', '2026-12-31T16:00:00.000Z', '2027-01-01'],
  ['2024-02-28', '2024-02-27T16:00:00.000Z', '2024-02-28T16:00:00.000Z', '2024-02-29'],
  ['2024-02-29', '2024-02-28T16:00:00.000Z', '2024-02-29T16:00:00.000Z', '2024-03-01'],
  ['2026-02-28', '2026-02-27T16:00:00.000Z', '2026-02-28T16:00:00.000Z', '2026-03-01'],
  ['1900-02-28', '1900-02-27T16:00:00.000Z', '1900-02-28T16:00:00.000Z', '1900-03-01'],
  ['2000-02-29', '2000-02-28T16:00:00.000Z', '2000-02-29T16:00:00.000Z', '2000-03-01'],
  ['0099-01-01', '0098-12-31T16:00:00.000Z', '0099-01-01T16:00:00.000Z', '0099-01-02'],
  ['1991-06-30', '1991-06-29T16:00:00.000Z', '1991-06-30T16:00:00.000Z', '1991-07-01'],
] as const;

it.each(days)('[AC-B1-08d#5] %s 自然日区间为固定 +08:00 的两个零点', (date, start, end) => {
  const range = chinaDayRange(date);
  expect(range.start).toBeInstanceOf(Date);
  expect(range.end).toBeInstanceOf(Date);
  expect([range.start.toISOString(), range.end.toISOString()]).toEqual([start, end]);
  expect(range.end.getTime() - range.start.getTime()).toBe(86_400_000);
});

it.each(days)(
  '[AC-B1-08d#6] %s 日区间左闭右开且与次日连续，日期往返不变',
  (date, _start, _end, next) => {
    const range = chinaDayRange(date);
    expect(chinaDate(range.start)).toBe(date);
    expect(chinaDate(new Date(range.end.getTime() - 1))).toBe(date);
    expect(chinaDate(range.end)).toBe(next);
    expect(chinaDate(new Date(range.start.getTime() - 1))).not.toBe(date);
    expect(range.end.getTime()).toBe(chinaDayRange(next).start.getTime());
  },
);

const months = [
  ['2026-10', '2026-09-30T16:00:00.000Z', '2026-10-31T16:00:00.000Z', '2026-11', 31],
  ['2026-11', '2026-10-31T16:00:00.000Z', '2026-11-30T16:00:00.000Z', '2026-12', 30],
  ['2026-12', '2026-11-30T16:00:00.000Z', '2026-12-31T16:00:00.000Z', '2027-01', 31],
  ['2027-01', '2026-12-31T16:00:00.000Z', '2027-01-31T16:00:00.000Z', '2027-02', 31],
  ['2026-02', '2026-01-31T16:00:00.000Z', '2026-02-28T16:00:00.000Z', '2026-03', 28],
  ['2024-02', '2024-01-31T16:00:00.000Z', '2024-02-29T16:00:00.000Z', '2024-03', 29],
  ['1900-02', '1900-01-31T16:00:00.000Z', '1900-02-28T16:00:00.000Z', '1900-03', 28],
  ['2000-02', '2000-01-31T16:00:00.000Z', '2000-02-29T16:00:00.000Z', '2000-03', 29],
  ['2100-02', '2100-01-31T16:00:00.000Z', '2100-02-28T16:00:00.000Z', '2100-03', 28],
  ['0099-01', '0098-12-31T16:00:00.000Z', '0099-01-31T16:00:00.000Z', '0099-02', 31],
  ['1991-06', '1991-05-31T16:00:00.000Z', '1991-06-30T16:00:00.000Z', '1991-07', 30],
] as const;

it.each(months)(
  '[AC-B1-08d#7] %s 自然月区间正确处理月长、跨年和闰年',
  (month, start, end, _next, length) => {
    const range = chinaMonthRange(month);
    expect(range.start).toBeInstanceOf(Date);
    expect(range.end).toBeInstanceOf(Date);
    expect([range.start.toISOString(), range.end.toISOString()]).toEqual([start, end]);
    expect(range.end.getTime() - range.start.getTime()).toBe(length * 86_400_000);
  },
);

it.each(months)(
  '[AC-B1-08d#8] %s 月区间左闭右开且与次月连续，月份往返不变',
  (month, _start, _end, next) => {
    const range = chinaMonthRange(month);
    expect(chinaMonth(range.start)).toBe(month);
    expect(chinaMonth(new Date(range.end.getTime() - 1))).toBe(month);
    expect(chinaMonth(range.end)).toBe(next);
    expect(chinaMonth(new Date(range.start.getTime() - 1))).not.toBe(month);
    expect(range.end.getTime()).toBe(chinaMonthRange(next).start.getTime());
    expect(range.start.getTime()).toBe(chinaDayRange(`${month}-01`).start.getTime());
  },
);
