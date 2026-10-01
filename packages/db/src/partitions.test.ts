import { expect, it } from 'vitest';

import {
  MONTH_PARTITIONED_TABLES,
  monthPartitionName,
  monthStartDate,
  monthsToEnsure,
  utcMonthStart,
} from './partitions.ts';

it('monthPartitionName uses the UTC month, zero padded', () => {
  expect(monthPartitionName('event_log', new Date('2026-10-01T00:00:00Z'))).toBe(
    'event_log_p202610',
  );
  expect(monthPartitionName('event_log', new Date('2027-01-15T12:00:00Z'))).toBe(
    'event_log_p202701',
  );
});

it('monthPartitionName follows UTC even when Beijing time is already in the next month', () => {
  // 2026-11-01 07:59:59 +08:00 is still October in UTC.
  expect(monthPartitionName('event_log', new Date('2026-11-01T07:59:59+08:00'))).toBe(
    'event_log_p202610',
  );
  // 2026-10-31 16:00:00 -08:00 is already November in UTC.
  expect(monthPartitionName('event_log', new Date('2026-10-31T16:00:00-08:00'))).toBe(
    'event_log_p202611',
  );
});

it('monthPartitionName rejects names that are not plain identifiers', () => {
  expect(() => monthPartitionName('event_log; drop', new Date('2026-10-01T00:00:00Z'))).toThrow(
    RangeError,
  );
  expect(() => monthPartitionName('', new Date('2026-10-01T00:00:00Z'))).toThrow(RangeError);
});

it('monthStartDate and utcMonthStart handle the last millisecond of a month', () => {
  const lastMs = new Date('2026-10-31T23:59:59.999Z');
  expect(monthStartDate(lastMs)).toBe('2026-10-01');
  expect(utcMonthStart(lastMs).toISOString()).toBe('2026-10-01T00:00:00.000Z');
  expect(monthStartDate(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11-01');
});

it('monthsToEnsure returns the current month plus the months ahead, across a year end', () => {
  const months = monthsToEnsure(new Date('2026-11-20T03:04:05Z'), 3);
  expect(months.map((m) => m.toISOString())).toEqual([
    '2026-11-01T00:00:00.000Z',
    '2026-12-01T00:00:00.000Z',
    '2027-01-01T00:00:00.000Z',
    '2027-02-01T00:00:00.000Z',
  ]);
});

it('monthsToEnsure with ahead 0 returns only the current month', () => {
  expect(monthsToEnsure(new Date('2028-02-29T23:59:59Z'), 0).map(monthStartDate)).toEqual([
    '2028-02-01',
  ]);
});

it('monthsToEnsure rejects invalid input', () => {
  expect(() => monthsToEnsure(new Date('2026-10-01T00:00:00Z'), -1)).toThrow(RangeError);
  expect(() => monthsToEnsure(new Date('2026-10-01T00:00:00Z'), 1.5)).toThrow(RangeError);
  expect(() => monthsToEnsure(new Date(Number.NaN), 3)).toThrow(RangeError);
});

it('the month-partitioned table list only contains plain identifiers', () => {
  expect(MONTH_PARTITIONED_TABLES.length).toBeGreaterThan(0);
  for (const table of MONTH_PARTITIONED_TABLES) {
    expect(monthPartitionName(table, new Date('2026-10-01T00:00:00Z'))).toBe(`${table}_p202610`);
  }
});
