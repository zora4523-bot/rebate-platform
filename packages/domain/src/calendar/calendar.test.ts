import { expect, it } from 'vitest';
import { accountingDate, chinaDayRange, chinaMonth, chinaMonthRange } from './index.ts';

it('chinaDayRange rolls over month end and year end', () => {
  expect([chinaDayRange('2026-10-31'), chinaDayRange('2026-12-31')]).toEqual([
    { start: '2026-10-31T00:00:00+08:00', end: '2026-11-01T00:00:00+08:00' },
    { start: '2026-12-31T00:00:00+08:00', end: '2027-01-01T00:00:00+08:00' },
  ]);
});

it('chinaMonthRange rolls December into January of the next year', () => {
  expect(chinaMonthRange('0000-12')).toEqual({
    start: '0000-12-01T00:00:00+08:00',
    end: '0001-01-01T00:00:00+08:00',
  });
});

it('ranges whose end would need a five-digit year throw RangeError', () => {
  expect(() => chinaDayRange('9999-12-31')).toThrow(RangeError);
  expect(() => chinaMonthRange('9999-12')).toThrow(RangeError);
});

it('non-Date inputs throw RangeError', () => {
  const notADate = { getTime: () => 0 } as unknown as Date;
  expect(() => accountingDate(notADate)).toThrow(RangeError);
  expect(() => chinaMonth(notADate)).toThrow(RangeError);
  expect(() => chinaDayRange(20261020 as unknown as string)).toThrow(RangeError);
});
