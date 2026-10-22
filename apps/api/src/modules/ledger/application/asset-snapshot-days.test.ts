import { expect, it } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { isPastDeadline, snapshotDayOf, snapshotDeadlineMs } from './asset-snapshot-days.ts';
import { LedgerError } from './errors.ts';

function at(iso: string): Date {
  return new FixedClock(iso).now();
}

it('[AC-B2-04w-UNIT#1] 名义 D+1 00:01 +08:00 写 D：跨月、跨年、闰日', () => {
  expect(snapshotDayOf(at('2032-06-15T16:01:00.000Z'))).toBe('2032-06-15');
  expect(snapshotDayOf(at('2032-02-29T16:01:00.000Z'))).toBe('2032-02-29');
  expect(snapshotDayOf(at('2032-12-31T16:01:00.000Z'))).toBe('2032-12-31');
  expect(snapshotDayOf(at('2032-02-29T16:00:00.000Z'))).toBe('2032-02-29');
  expect(snapshotDayOf(at('2032-02-29T15:59:59.999Z'))).toBe('2032-02-28');
});

it('[AC-B2-04w-UNIT#2] 截止线是 D+1 00:30 +08:00，边界本身算超时', () => {
  expect(snapshotDeadlineMs('2032-06-15')).toBe(at('2032-06-15T16:30:00.000Z').getTime());
  expect(snapshotDeadlineMs('2032-12-31')).toBe(at('2032-12-31T16:30:00.000Z').getTime());
  expect(isPastDeadline(at('2032-06-15T16:29:59.999Z'), '2032-06-15')).toBe(false);
  expect(isPastDeadline(at('2032-06-15T16:30:00.000Z'), '2032-06-15')).toBe(true);
});

it('[AC-B2-04w-UNIT#3] 非法日期与非法时刻拒绝为 INVALID_INPUT', () => {
  expect(() => snapshotDeadlineMs('2032-02-30')).toThrow(LedgerError);
  expect(() => snapshotDeadlineMs('2032-6-1')).toThrow(LedgerError);
  expect(() => snapshotDayOf('2032-06-16T00:01:00+08:00' as never)).toThrow(LedgerError);
});
