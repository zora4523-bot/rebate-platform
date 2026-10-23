import { expect, it } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import { parseCalendarDay, plusEightDay } from './dates.ts';

it('[AC-B3-08a#4] parseCalendarDay counts days from 1970-01-01', () => {
  expect(parseCalendarDay('1970-01-01')).toBe(0);
  expect(parseCalendarDay('1970-03-01')).toBe(59);
  expect(parseCalendarDay('2026-10-23')! - parseCalendarDay('2026-07-26')!).toBe(89);
  expect(parseCalendarDay('2026-09-30')! - parseCalendarDay('2026-07-01')!).toBe(91);
});

it('[AC-B3-08a#4] parseCalendarDay refuses days that do not exist instead of rolling over', () => {
  for (const value of ['2025-13-01', '2026-02-29', '2026-02-30', '2026-04-31', '2026-00-10']) {
    expect(parseCalendarDay(value)).toBeNull();
  }
  expect(parseCalendarDay('2028-02-29')).not.toBeNull();
  expect(parseCalendarDay('2000-02-29')).not.toBeNull();
  expect(parseCalendarDay('2100-02-29')).toBeNull();
  for (const value of ['2026-10-1', '2026/10/01', '20261001', '2026-10-01T00:00:00']) {
    expect(parseCalendarDay(value)).toBeNull();
  }
});

it('[AC-B3-08a#4] plusEightDay switches day at 16:00 UTC', () => {
  const day = parseCalendarDay('2026-10-23');
  expect(plusEightDay(new FixedClock('2026-10-22T23:30:00.000Z').now())).toBe(day);
  expect(plusEightDay(new FixedClock('2026-10-23T15:59:59.999Z').now())).toBe(day);
  expect(plusEightDay(new FixedClock('2026-10-23T16:00:00.000Z').now())).toBe(day! + 1);
});
