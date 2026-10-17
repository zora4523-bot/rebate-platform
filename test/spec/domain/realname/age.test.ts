import { ageAt, isAtLeastAge, reachedAgeAt } from '@couli/domain';
import { expect, it } from 'vitest';

it.each([
  ['2012-09-29', 14, '2026-09-30T00:00:00+08:00'],
  ['2012-09-28', 14, '2026-09-29T00:00:00+08:00'],
  ['2008-09-28', 18, '2026-09-29T00:00:00+08:00'],
  ['2008-02-29', 18, '2026-03-02T00:00:00+08:00'],
  ['2004-02-29', 20, '2024-03-01T00:00:00+08:00'],
  ['1896-02-29', 4, '1900-03-02T00:00:00+08:00'],
  ['1996-02-29', 4, '2000-03-01T00:00:00+08:00'],
  ['2096-02-29', 4, '2100-03-02T00:00:00+08:00'],
  ['2012-12-31', 14, '2027-01-01T00:00:00+08:00'],
  ['2012-01-31', 14, '2026-02-01T00:00:00+08:00'],
  ['2012-04-30', 14, '2026-05-01T00:00:00+08:00'],
  ['2012-02-28', 12, '2024-02-29T00:00:00+08:00'],
  ['2012-02-28', 14, '2026-03-01T00:00:00+08:00'],
  ['2012-09-29', 1, '2013-09-30T00:00:00+08:00'],
  ['2012-09-29', 65, '2077-09-30T00:00:00+08:00'],
])('[AC-B1-13c#8] %s 满 %i 周岁在 %s，差 1 毫秒未满', (birth, years, expected) => {
  const threshold = new Date(expected);
  const before = new Date(threshold.getTime() - 1);
  expect(reachedAgeAt(birth, years)).toEqual(threshold);
  expect(ageAt(birth, before)).toBe(years - 1);
  expect(ageAt(birth, threshold)).toBe(years);
  expect(isAtLeastAge(birth, years, before)).toBe(false);
  expect(isAtLeastAge(birth, years, threshold)).toBe(true);
});

it.each([
  ['2026-09-29T00:00:00+08:00', 13, false],
  ['2026-09-29T23:59:59.999+08:00', 13, false],
  ['2026-09-30T00:00:00+08:00', 14, true],
  ['2026-09-29T16:00:00Z', 14, true],
  ['2026-09-30T07:59:59.999+08:00', 14, true],
  ['2026-09-30T23:59:59.999+08:00', 14, true],
  ['2026-10-01T00:00:00+08:00', 14, true],
] as const)('[AC-B1-13c#9] 北京生日当天、早八点前及月界：%s', (instant, age, reached) => {
  const at = new Date(instant);
  const original = at.getTime();
  expect(ageAt('2012-09-29', at)).toBe(age);
  expect(isAtLeastAge('2012-09-29', 14, at)).toBe(reached);
  expect(at.getTime()).toBe(original);
});

it.each([
  ['2012-09-29', '2012-09-30T00:00:00+08:00'],
  ['2008-02-29', '2008-03-01T00:00:00+08:00'],
])('[AC-B1-13c#10] %s 满 0 周岁也在出生次日，ageAt 不出负数', (birth, expected) => {
  const threshold = new Date(expected);
  expect(reachedAgeAt(birth, 0)).toEqual(threshold);
  for (const at of [new Date('1800-01-01T00:00:00Z'), new Date(threshold.getTime() - 1)]) {
    expect(ageAt(birth, at)).toBe(0);
    expect(isAtLeastAge(birth, 0, at)).toBe(false);
  }
  expect(ageAt(birth, threshold)).toBe(0);
  expect(isAtLeastAge(birth, 0, threshold)).toBe(true);
});

it.each([
  '',
  '20120929',
  '12-09-29',
  '2012-9-29',
  '2012-09-9',
  '2012/09/29',
  ' 2012-09-29',
  '2012-09-29\n',
  '2012-09-29T00:00:00+08:00',
  '２０１２-０９-２９',
  '2012-00-01',
  '2012-13-01',
  '2012-01-00',
  '2012-01-32',
  '2012-04-31',
  '2012-06-31',
  '2012-09-31',
  '2012-11-31',
  '1999-02-30',
  '2001-02-29',
  '1900-02-29',
  '2100-02-29',
  '2000-02-30',
])('[AC-B1-13c#11] 年龄函数拒绝非法出生日期 %j，均抛 RangeError', (birth) => {
  const at = new Date('2026-09-29T16:00:00Z');
  expect(() => reachedAgeAt(birth, 14)).toThrow(RangeError);
  expect(() => ageAt(birth, at)).toThrow(RangeError);
  expect(() => isAtLeastAge(birth, 14, at)).toThrow(RangeError);
});

it.each([-1, 1.5, NaN, Infinity, -Infinity])('[AC-B1-13c#12] 年数必须为非负整数：%s', (years) => {
  expect(() => reachedAgeAt('2012-09-29', years)).toThrow(RangeError);
  expect(() => isAtLeastAge('2012-09-29', years, new Date('2026-09-29T16:00:00Z'))).toThrow(
    RangeError,
  );
});

it.each([
  new Date(NaN),
  new Date(Infinity),
  '2026-09-29T16:00:00Z',
  1790697600000,
  null,
  undefined,
  {},
  { getTime: (): number => 1790697600000 },
])('[AC-B1-13c#13] at 必须为有效 Date 实例：%j', (input) => {
  const at = input as Date;
  expect(() => ageAt('2012-09-29', at)).toThrow(RangeError);
  expect(() => isAtLeastAge('2012-09-29', 14, at)).toThrow(RangeError);
});
