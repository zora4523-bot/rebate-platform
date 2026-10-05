// Unit rule tests of the day-partition additions to platform/maintenance (B1-01s; contract section
// I2 in apps/api/src/modules/platform/maintenance/index.ts). Basis: ADR-0001 §4.2 #4 (按日的表预建未来
// 14 天), #5 (link_logs 按日), #10 (时钟只读注入); BR-ID-30 (运行当日 00:00（+08:00）: days are +08:00
// calendar days). No database, no port, no network.
import { expect, it } from 'vitest';

import {
  DAY_PARTITIONED_TABLES,
  DAYS_AHEAD,
  DROPPABLE_TABLES,
  createPartitionMaintenance,
  dayPartitionDays,
  type PartitionMaintenanceOptions,
} from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import { countingClock, memoryLogger, thrownProblems } from './kit.ts';

/** dayPartitionDays(new Date(instant)), or `threw <name>` (so a scenario fails on its assertion). */
function daysAt(instant: string | number): string[] | string {
  try {
    return dayPartitionDays(new Date(instant));
  } catch (error) {
    return `threw ${error instanceof Error ? error.name : String(error)}`;
  }
}

it('[ADR-0001 §4.2 #4、#5; contract I2] 常量：日分区表正好是 [link_logs]（冻结），预建 14 天；可删月分区表仍正好是 [event_log]；dayPartitionDays 在 2026-11-19T15:59:59.999Z（+08:00 的 11-19 最后 1 毫秒）给 2026-11-19 至 2026-12-03 共 15 天，再晚 1 毫秒给 2026-11-20 至 2026-12-04', () => {
  expect({
    tables: [...DAY_PARTITIONED_TABLES],
    frozen: Object.isFrozen(DAY_PARTITIONED_TABLES),
    ahead: DAYS_AHEAD,
    droppable: [...DROPPABLE_TABLES],
  }).toEqual({ tables: ['link_logs'], frozen: true, ahead: 14, droppable: ['event_log'] });
  expect(daysAt('2026-11-19T15:59:59.999Z')).toEqual([
    '2026-11-19',
    '2026-11-20',
    '2026-11-21',
    '2026-11-22',
    '2026-11-23',
    '2026-11-24',
    '2026-11-25',
    '2026-11-26',
    '2026-11-27',
    '2026-11-28',
    '2026-11-29',
    '2026-11-30',
    '2026-12-01',
    '2026-12-02',
    '2026-12-03',
  ]);
  expect(daysAt('2026-11-19T16:00:00.000Z')).toEqual([
    '2026-11-20',
    '2026-11-21',
    '2026-11-22',
    '2026-11-23',
    '2026-11-24',
    '2026-11-25',
    '2026-11-26',
    '2026-11-27',
    '2026-11-28',
    '2026-11-29',
    '2026-11-30',
    '2026-12-01',
    '2026-12-02',
    '2026-12-03',
    '2026-12-04',
  ]);
});

it('[BR-ID-30 +08:00 日界; contract I2] dayPartitionDays 跨年、闰年、UTC 已是次日或仍是前日：首日与末日确切、每天各一、升序', () => {
  const span = (instant: string): unknown => {
    const days = daysAt(instant);
    if (typeof days === 'string') return days;
    return { first: days[0], last: days.at(-1), count: days.length, unique: new Set(days).size };
  };
  expect({
    // 2026-12-31 23:59:59.999 +08:00.
    newYearsEve: span('2026-12-31T15:59:59.999Z'),
    // 2027-01-01 00:00 +08:00, still 2026-12-31 in UTC.
    newYear: span('2026-12-31T16:00:00.000Z'),
    // 2028-02-15 12:00 +08:00: the 15 days pass 2028-02-29.
    leap: span('2028-02-15T04:00:00Z'),
    // 2027-02-15: no 29th.
    common: span('2027-02-15T04:00:00Z'),
    // 2026-11-20 07:59:59.999 +08:00 — UTC midnight has no effect.
    utcMidnight: span('2026-11-20T00:00:00.000Z'),
  }).toEqual({
    newYearsEve: { first: '2026-12-31', last: '2027-01-14', count: 15, unique: 15 },
    newYear: { first: '2027-01-01', last: '2027-01-15', count: 15, unique: 15 },
    leap: { first: '2028-02-15', last: '2028-02-29', count: 15, unique: 15 },
    common: { first: '2027-02-15', last: '2027-03-01', count: 15, unique: 15 },
    utcMidnight: { first: '2026-11-20', last: '2026-12-04', count: 15, unique: 15 },
  });
  expect(daysAt('2028-02-15T04:00:00Z')).toContain('2028-02-29');
  expect(daysAt('2027-02-15T04:00:00Z')).not.toContain('2027-02-29');
});

it('[contract I2] dayPartitionDays 只看参数：不读墙钟（同一参数结果相同，与当前时刻无关）；无效 Date 抛 RangeError', () => {
  expect(daysAt('2001-09-09T01:46:40Z')).toEqual(daysAt(1_000_000_000_000));
  expect(daysAt('2001-09-09T01:46:40Z')).toEqual(
    Array.from({ length: 15 }, (_, i) => `2001-09-${String(9 + i).padStart(2, '0')}`),
  );
  expect(daysAt(Number.NaN)).toBe('threw RangeError');
  expect(daysAt('not a date')).toBe('threw RangeError');
});

function base(): PartitionMaintenanceOptions & Record<string, unknown> {
  return {
    db: {} as PartitionMaintenanceOptions['db'],
    logger: memoryLogger().logger,
    clock: countingClock('2026-11-20T03:04:05Z'),
  };
}

it('[contract B、I2] 选项 dayPartitions 只能是 true 或 false：undefined、null、字符串、数字、Boolean 对象一律同步抛 invalid_option', () => {
  const bad: Record<string, unknown> = {
    undefined: undefined,
    null: null,
    stringTrue: 'true',
    stringFalse: 'false',
    one: 1,
    zero: 0,
    booleanObject: new Boolean(true),
    array: [true],
  };
  const got: Record<string, string[]> = {};
  for (const [label, value] of Object.entries(bad)) {
    got[label] = thrownProblems(
      () =>
        createPartitionMaintenance({
          ...base(),
          dayPartitions: value,
        } as PartitionMaintenanceOptions),
      'invalid_option',
    );
  }
  expect(got).toEqual(Object.fromEntries(Object.keys(bad).map((label) => [label, []])));
});

it('[contract B、I2] dayPartitions 为 true 或 false（也与 intervalMs、quietDefaultTables 同用）时得到 runOnce / start / stop；创建时不读时钟、不写日志、不碰 db', () => {
  const got: string[] = [];
  for (const extra of [
    { dayPartitions: true },
    { dayPartitions: false },
    { dayPartitions: true, intervalMs: 100, quietDefaultTables: ['link_logs'] },
  ]) {
    const clock = countingClock('2026-11-20T03:04:05Z');
    const { logger, lines } = memoryLogger();
    const touched: string[] = [];
    const db = new Proxy(
      {},
      {
        get(_target, key) {
          touched.push(String(key));
          return undefined;
        },
      },
    ) as PartitionMaintenanceOptions['db'];
    try {
      const instance = createPartitionMaintenance({ db, logger, clock, ...extra });
      got.push(
        [
          typeof instance.runOnce,
          typeof instance.start,
          typeof instance.stop,
          `clock ${String(clock.calls())}`,
          `lines ${String(lines.length)}`,
          `db ${touched.join(',')}`,
        ].join(' '),
      );
    } catch (error) {
      got.push(`threw ${String(error)}`);
    }
  }
  expect(got).toEqual(Array(3).fill('function function function clock 0 lines 0 db '));
});
