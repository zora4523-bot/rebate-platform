// B1-15zc — worker 维护轮次里丢 union_raw_payloads 的过期月分区（BR-ID-30 正文、⑦；编排 D10-451、D10-454、
// D10-458）。契约见 ./kit.ts 文件头。「不丢」的场景在骨架上本来就成立，所以这些用例都接着验证同一批分区随后被丢。
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { createPartitionMaintenance } from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import { createWorkerMaintenance } from '../../../../apps/api/src/modules/platform/maintenance/worker.ts';
import { ensureMonths, names, partitionNames } from '../../db/partitions/kit.ts';
import {
  ALL_ENSURED,
  done,
  line,
  memoryLogger,
  MONTH_ENSURED,
  reduceLine,
  settableClock,
} from '../maintenance/kit.ts';
import {
  countRows,
  holdLock,
  inWorld,
  retentionLines,
  seedRow,
  setConfig,
  shift,
  type World,
} from '../retention/kit.ts';
import {
  BEFORE_GATE,
  CUTOFF,
  DAYS_KEY,
  dropLine,
  EXPIRED_MONTHS,
  holdRawRead,
  leftAfterRun,
  LONGER_DAYS,
  monthPartition,
  NEXT_DAY,
  NOW,
  OLD_MONTHS,
  rawRows,
  rowsOf,
  seedOldMonths,
  seedRaw,
  TABLE,
  workerAt,
} from './kit.ts';

async function withWorld(scenario: (world: World) => Promise<void>): Promise<void> {
  await inWorld(await createTestDatabase(), scenario);
}

const SWITCH_KEY = 'retention.purge.enabled';

/** NOW 的 190 天截断点是 2026-06-21 00:00（+08:00）：event_log_p202605 到期。 */
const EVENT_LOG_MONTH = '2026-05';
const EVENT_LOG_PARTITION = 'event_log_p202605';

/** 比 notify_logs 在 NOW 的截断点 2026-06-20T16:00:00Z 早一毫秒。 */
const NOTIFY_EXPIRED = '2026-06-20T15:59:59.999Z';

it.each(['module', 'worker'] as const)(
  '[AC-B1-15zc#12] %s：只在 04:00（+08:00）门内丢，03:59:59.999 不动；无配置行时按 180 天，只丢整月过期的分区，时钟每轮只读一次；次日门内再丢下一个月',
  async (entry) => {
    await withWorld(async (world) => {
      const { app, maint } = world;
      await seedOldMonths(world);
      const clock = settableClock('2026-12-27T16:00:00.000Z'); // 12-28 00:00 +08:00
      const { logger } = memoryLogger();
      const options = { db: maint, clock, logger };
      const maintenance =
        entry === 'worker'
          ? createWorkerMaintenance(options)
          : createPartitionMaintenance({ ...options, dayPartitions: true });

      expect(await maintenance.runOnce()).toMatchObject({ dropped: [], failed: 0 });
      clock.set(BEFORE_GATE);
      expect(await maintenance.runOnce()).toMatchObject({ dropped: [], failed: 0 });
      expect(await partitionNames(app, TABLE)).toEqual(leftAfterRun(OLD_MONTHS));
      expect(clock.calls()).toBe(2);

      clock.set(NOW);
      expect(await maintenance.runOnce()).toMatchObject({
        dropped: names(TABLE, EXPIRED_MONTHS),
        failed: 0,
      });
      expect(await partitionNames(app, TABLE)).toEqual(leftAfterRun(['2026-06']));
      expect(await rawRows(app)).toEqual(rowsOf(['2026-06']));
      expect(clock.calls()).toBe(3);

      clock.set(NEXT_DAY);
      expect(await maintenance.runOnce()).toMatchObject({
        dropped: [monthPartition('2026-06')],
        failed: 0,
      });
      expect(await rawRows(app)).toEqual([]);
    });
  },
  60_000,
);

it.each(['"220"', '220.5', 'true', 'null', '{"days":220}', '[220]', '0', '-1', '29', '179'])(
  '[AC-B1-15zc#13] retention.union_raw_payloads_days 为 %s 不可用：回落 180 天照常丢、不记失败，p202605 丢、p202606 留',
  async (value) => {
    await withWorld(async (world) => {
      const { app } = world;
      await seedOldMonths(world);
      await setConfig(app, DAYS_KEY, value);
      const { maintenance } = workerAt(world, NOW);
      expect(await maintenance.runOnce()).toMatchObject({
        dropped: names(TABLE, EXPIRED_MONTHS),
        failed: 0,
      });
      expect(await partitionNames(app, TABLE)).toEqual(leftAfterRun(['2026-06']));
    });
  },
  60_000,
);

it('[AC-B1-15zc#14] retention.union_raw_payloads_days 改长后保留更久：220 天只丢 p202604；每轮重读，改回 180 下一轮丢 p202605', async () => {
  await withWorld(async (world) => {
    const { app } = world;
    await seedOldMonths(world);
    await setConfig(app, DAYS_KEY, String(LONGER_DAYS));
    const { maintenance } = workerAt(world, NOW);
    expect(await maintenance.runOnce()).toMatchObject({
      dropped: [monthPartition('2026-04')],
      failed: 0,
    });
    expect(await partitionNames(app, TABLE)).toEqual(leftAfterRun(['2026-05', '2026-06']));

    await setConfig(app, DAYS_KEY, '180');
    expect(await maintenance.runOnce()).toMatchObject({
      dropped: [monthPartition('2026-05')],
      failed: 0,
    });
    expect(await partitionNames(app, TABLE)).toEqual(leftAfterRun(['2026-06']));
  });
}, 60_000);

it('[AC-B1-15zc#15] 高于函数上限的配置值按 36500 天，不回落 180：什么都不丢也不记失败；改回 180 后才丢', async () => {
  await withWorld(async (world) => {
    const { app } = world;
    await seedOldMonths(world);
    await setConfig(app, DAYS_KEY, '99999');
    const { maintenance } = workerAt(world, NOW);
    expect(await maintenance.runOnce()).toMatchObject({ dropped: [], failed: 0 });
    expect(await partitionNames(app, TABLE)).toEqual(leftAfterRun(OLD_MONTHS));

    await setConfig(app, DAYS_KEY, '180');
    expect(await maintenance.runOnce()).toMatchObject({
      dropped: names(TABLE, EXPIRED_MONTHS),
      failed: 0,
    });
  });
}, 60_000);

it('[AC-B1-15zc#16] retention.purge.enabled 为 false：不丢本表，event_log 的月分区照丢；改回 true 下一轮丢本表', async () => {
  await withWorld(async (world) => {
    const { app, maint } = world;
    await seedOldMonths(world);
    await ensureMonths(maint, 'event_log', [EVENT_LOG_MONTH]);
    await setConfig(app, SWITCH_KEY, 'false');
    const { maintenance, lines } = workerAt(world, NOW);

    expect(await maintenance.runOnce()).toMatchObject({
      dropped: [EVENT_LOG_PARTITION],
      failed: 0,
    });
    expect(await partitionNames(app, TABLE)).toEqual(leftAfterRun(OLD_MONTHS));
    expect(await rawRows(app)).toEqual(rowsOf(OLD_MONTHS));
    expect(lines.map(reduceLine)).toEqual([
      dropLine('event_log', EVENT_LOG_PARTITION),
      done(ALL_ENSURED, 1, 0),
    ]);

    await setConfig(app, SWITCH_KEY, 'true');
    expect(await maintenance.runOnce()).toMatchObject({
      dropped: names(TABLE, EXPIRED_MONTHS),
      failed: 0,
    });
  });
}, 60_000);

it.each(['true', '"false"', '0', 'null'])(
  '[AC-B1-15zc#17] retention.purge.enabled 为 %s：不是 false 就算开，照常丢',
  async (value) => {
    await withWorld(async (world) => {
      await seedOldMonths(world);
      await setConfig(world.app, SWITCH_KEY, value);
      const { maintenance } = workerAt(world, NOW);
      expect(await maintenance.runOnce()).toMatchObject({
        dropped: names(TABLE, EXPIRED_MONTHS),
        failed: 0,
      });
    });
  },
  60_000,
);

it('[AC-B1-15zc#18] 配置读失败：开关未知，本表不丢，只记一行 retention_purge_failed，event_log 照丢；下一轮补上', async () => {
  await withWorld(async (world) => {
    const { app, maint, database } = world;
    await seedOldMonths(world);
    await ensureMonths(maint, 'event_log', [EVENT_LOG_MONTH]);
    const { maintenance, lines } = workerAt(world, NOW);
    const lock = holdLock(database, (trx) =>
      sql`LOCK TABLE app.config_items IN ACCESS EXCLUSIVE MODE`.execute(trx),
    );
    try {
      await lock.ready;
      expect(await maintenance.runOnce()).toMatchObject({
        dropped: [EVENT_LOG_PARTITION],
        failed: 1,
      });
    } finally {
      lock.release();
      await lock.done;
    }
    expect(await partitionNames(app, TABLE)).toEqual(leftAfterRun(OLD_MONTHS));
    expect(retentionLines(lines)).toEqual([
      line('error', 'retention_purge_failed', { table: 'config_items', sqlstate: '55P03' }),
    ]);

    expect(await maintenance.runOnce()).toMatchObject({
      dropped: names(TABLE, EXPIRED_MONTHS),
      failed: 0,
    });
  });
}, 60_000);

it('[AC-B1-15zc#19] 丢本表拿不到锁：记 partition_drop_failed（55P03），什么都没丢，同轮 login_logs 照删、DEFAULT 检查照做；下一轮丢掉', async () => {
  await withWorld(async (world) => {
    const { app, database } = world;
    await seedOldMonths(world);
    await seedRow(app, 'login_logs', shift(CUTOFF, -1));
    const { maintenance, clock, lines } = workerAt(world, BEFORE_GATE);
    // 门外先跑一轮把月分区建齐：有 DEFAULT 分区时建分区也要等这把读锁，不能混进本用例的失败计数。
    expect((await maintenance.runOnce()).failed).toBe(0);
    clock.set(NOW);
    lines.length = 0;

    const lock = holdRawRead(database);
    try {
      await lock.ready;
      const report = await maintenance.runOnce();
      expect(report.dropped).toEqual([]);
      expect(report.failed).toBe(1);
      expect(report.ensured).toHaveLength(ALL_ENSURED);
    } finally {
      lock.release();
      await lock.done;
    }
    expect(await partitionNames(app, TABLE)).toEqual(leftAfterRun(OLD_MONTHS));
    expect(await countRows(app, 'login_logs')).toBe(0n);
    const written = lines.map(reduceLine);
    expect(written).toHaveLength(3);
    expect(written).toEqual(
      expect.arrayContaining([
        line('error', 'partition_drop_failed', { table: TABLE, sqlstate: '55P03' }),
        line('info', 'retention_purged', { table: 'login_logs', rows: 1 }),
      ]),
    );
    expect(written.at(-1)).toEqual(done(ALL_ENSURED, 0, 1));

    expect(await maintenance.runOnce()).toMatchObject({
      dropped: names(TABLE, EXPIRED_MONTHS),
      failed: 0,
    });
  });
}, 60_000);

it('[AC-B1-15zc#20] 第 K 节的表失败不挡本表：notify_logs 拿不到锁时本表照丢，只记这一个失败', async () => {
  await withWorld(async (world) => {
    const { app, database } = world;
    await seedOldMonths(world);
    await seedRow(app, 'notify_logs', NOTIFY_EXPIRED);
    const { maintenance, lines } = workerAt(world, NOW);
    const lock = holdLock(database, (trx) =>
      sql`LOCK TABLE app.notify_logs IN ACCESS EXCLUSIVE MODE`.execute(trx),
    );
    try {
      await lock.ready;
      expect(await maintenance.runOnce()).toMatchObject({
        dropped: names(TABLE, EXPIRED_MONTHS),
        failed: 1,
      });
    } finally {
      lock.release();
      await lock.done;
    }
    expect(await partitionNames(app, TABLE)).toEqual(leftAfterRun(['2026-06']));
    expect(retentionLines(lines)).toEqual([
      line('error', 'retention_purge_failed', { table: 'notify_logs', sqlstate: '55P03' }),
    ]);
  });
}, 60_000);

it('[AC-B1-15zc#21] 报告形状不变，日志只有表名与分区名：每丢一个分区一行，计入 done；再跑一轮只有 done', async () => {
  await withWorld(async (world) => {
    await seedOldMonths(world);
    const { maintenance, lines } = workerAt(world, NOW);

    const report = await maintenance.runOnce();
    expect(Object.keys(report).sort()).toEqual(['defaultRows', 'dropped', 'ensured', 'failed']);
    expect(report).toMatchObject({
      dropped: names(TABLE, EXPIRED_MONTHS),
      defaultRows: [],
      failed: 0,
    });
    expect(report.ensured).toHaveLength(ALL_ENSURED);
    expect(lines.map(reduceLine)).toEqual([
      ...names(TABLE, EXPIRED_MONTHS).map((partition) => dropLine(TABLE, partition)),
      done(ALL_ENSURED, EXPIRED_MONTHS.length, 0),
    ]);

    lines.length = 0;
    expect(await maintenance.runOnce()).toMatchObject({ dropped: [], failed: 0 });
    expect(lines.map(reduceLine)).toEqual([done(ALL_ENSURED, 0, 0)]);
  });
}, 60_000);

it('[AC-B1-15zc#22] DEFAULT 分区不丢：里面再旧的行也留着，DEFAULT 告警照旧', async () => {
  await withWorld(async (world) => {
    const { app } = world;
    await seedOldMonths(world);
    const stale = '2020-01-15T00:00:00.000Z';
    await seedRaw(app, stale);
    const { maintenance, lines } = workerAt(world, NOW);
    const defaults = { table: TABLE, partition: `${TABLE}_default`, rows: 1 };

    expect(await maintenance.runOnce()).toMatchObject({
      dropped: names(TABLE, EXPIRED_MONTHS),
      defaultRows: [defaults],
      failed: 0,
    });
    expect(await partitionNames(app, TABLE)).toEqual(leftAfterRun(['2026-06']));
    expect(await rawRows(app)).toEqual([
      { part: `app.${TABLE}_default`, at: stale },
      ...rowsOf(['2026-06']),
    ]);
    expect(lines.map(reduceLine)).toEqual(
      expect.arrayContaining([line('warn', 'partition_default_has_rows', defaults)]),
    );
  });
}, 60_000);

it('[AC-B1-15zc#23] dayPartitions 未开的实例不动本表（第 K 节同一条件）；同一时刻 worker 实例丢掉', async () => {
  await withWorld(async (world) => {
    const { app, maint } = world;
    await seedOldMonths(world);
    const { logger, lines } = memoryLogger();
    const plain = createPartitionMaintenance({ db: maint, logger, clock: settableClock(NOW) });
    expect(await plain.runOnce()).toMatchObject({ dropped: [], failed: 0 });
    expect(await partitionNames(app, TABLE)).toEqual(leftAfterRun(OLD_MONTHS));
    expect(lines.map(reduceLine)).toEqual([done(MONTH_ENSURED, 0, 0)]);

    const { maintenance } = workerAt(world, NOW);
    expect(await maintenance.runOnce()).toMatchObject({
      dropped: names(TABLE, EXPIRED_MONTHS),
      failed: 0,
    });
  });
}, 60_000);
