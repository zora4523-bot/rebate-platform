// B1-15zb — worker 维护轮次里的保留期清理（BR-ID-30 正文、⑥⑩⑮⑯⑱；编排 D10-451、D10-454、D10-457、
// D10-458）。契约见 ./kit.ts 文件头。「不清」的场景在骨架上本来就成立，所以这些用例都接着验证同一批行随后
// 被删，或先要求函数已存在，否则红不起来。
import { randomBytes, randomUUID } from 'node:crypto';

import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { expect, it } from 'vitest';

import { createPartitionMaintenance } from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import { createWorkerMaintenance } from '../../../../apps/api/src/modules/platform/maintenance/worker.ts';
import { sqlState } from '../../db/partitions/kit.ts';
import {
  ALL_ENSURED,
  done,
  line,
  memoryLogger,
  reduceLine,
  settableClock,
} from '../maintenance/kit.ts';
import {
  boundary,
  boundaryRow,
  bothRows,
  CREATED_AT_TABLES,
  CUTOFF,
  countRows,
  DAY_MS,
  daysKey,
  expectLeft,
  holdLock,
  inWorld,
  NOTIFY_CHANNELS,
  notifyRows,
  NOW,
  PURGED_TABLES,
  requireFunctions,
  RETAINED_DAYS,
  retentionLines,
  seedAround,
  seedLoginLogs,
  seedNotifyLog,
  seedRow,
  setConfig,
  shift,
  startWorker,
  times,
  type World,
} from './kit.ts';

async function withWorld(scenario: (world: World) => Promise<void>): Promise<void> {
  await inWorld(await createTestDatabase(), scenario);
}

/** 每批行数与每轮批数上限（契约值，第 J 节同值）。 */
const BATCH_SIZE = 1000;
const MAX_BATCHES = 100;

/** NOW 减 200 天：2026-05-04 00:00（+08:00）。 */
const CUTOFF_200 = '2026-05-03T16:00:00.000Z';

const LINK = '00000000-0000-7000-8000-000000000001';

async function seedExpiredOpenAttempt(app: Kysely<DB>): Promise<void> {
  await sql`
    INSERT INTO app.links (app_id, link_id, platform, scene, expire_at)
    VALUES ('couli', ${LINK}::uuid, 'demo', 'self', '2027-01-01T00:00:00Z'::timestamptz)
  `.execute(app);
  // NOW 减 90 天的截断点是 2026-08-21T16:00:00Z，第 J 节的清理对象。
  await sql`
    INSERT INTO app.link_open_attempts (attempt_id, app_id, link_id, opened_at, created_at)
    VALUES (${randomUUID()}::uuid, 'couli', ${LINK}::uuid,
      '2026-08-21T15:59:59.999Z'::timestamptz, ${NOW}::timestamptz)
  `.execute(app);
}

it.each(['module', 'worker'] as const)(
  '[AC-B1-15zb#8] %s：只在 04:00（+08:00）门内清理，03:59:59.999 不动；无配置行时六张表按 08 现值清理且时钟每轮只读一次',
  async (entry) => {
    await withWorld(async (world) => {
      const { app, maint } = world;
      await seedAround(app);
      const clock = settableClock('2026-11-19T16:00:00.000Z'); // 11-20 00:00 +08:00
      const { logger, lines } = memoryLogger();
      const options = { db: maint, clock, logger };
      const maintenance =
        entry === 'worker'
          ? createWorkerMaintenance(options)
          : createPartitionMaintenance({ ...options, dayPartitions: true });

      expect((await maintenance.runOnce()).failed).toBe(0);
      await expectLeft(app, bothRows);
      clock.set('2026-11-19T19:59:59.999Z'); // 11-20 03:59:59.999 +08:00
      expect((await maintenance.runOnce()).failed).toBe(0);
      await expectLeft(app, bothRows);
      expect(retentionLines(lines)).toEqual([]);
      expect(clock.calls()).toBe(2);

      clock.set(NOW);
      expect((await maintenance.runOnce()).failed).toBe(0);
      await expectLeft(app, boundaryRow);
      expect(clock.calls()).toBe(3);
    });
  },
  60_000,
);

it.each(['"200"', '200.5', 'true', 'null', '{"days":200}', '[200]', '0', '-1', '29'])(
  '[AC-B1-15zb#9] 配置值 %s 不合法：回落 08 现值，到期行照删、分界上的行保留',
  async (value) => {
    await withWorld(async (world) => {
      const { app } = world;
      await seedAround(app);
      for (const table of CREATED_AT_TABLES) await setConfig(app, daysKey(table), value);
      const { maintenance } = startWorker(world);
      expect((await maintenance.runOnce()).failed).toBe(0);
      await expectLeft(app, boundaryRow);
    });
  },
  60_000,
);

it.each([1, 90, 150])(
  '[AC-B1-15zb#10] 配置比 08 现值少 %i 天：视同不合法，回落 08 现值照常清理不记失败，到期行删掉，分界上与更新的行都保留',
  async (below) => {
    await withWorld(async (world) => {
      const { app, maint } = world;
      await requireFunctions(maint);
      for (const table of CREATED_AT_TABLES) {
        await setConfig(app, daysKey(table), String(RETAINED_DAYS[table] - below));
        await seedRow(app, table, shift(boundary(table), -1));
        await seedRow(app, table, boundary(table));
        await seedRow(app, table, shift(boundary(table), DAY_MS));
      }
      const { maintenance, lines } = startWorker(world);
      expect((await maintenance.runOnce()).failed).toBe(0);
      for (const table of CREATED_AT_TABLES) {
        expect(await times(app, table), table).toEqual([
          boundary(table),
          shift(boundary(table), DAY_MS),
        ]);
      }
      const written = retentionLines(lines);
      expect(written).toHaveLength(CREATED_AT_TABLES.length);
      expect(written).toEqual(
        expect.arrayContaining(
          CREATED_AT_TABLES.map((table) => line('info', 'retention_purged', { table, rows: 1 })),
        ),
      );
    });
  },
  60_000,
);

it.each(CREATED_AT_TABLES)(
  '[AC-B1-15zb#11] retention.%s_days 改长：每轮重读，本表按新值，其他表仍按 08 现值',
  async (table) => {
    await withWorld(async (world) => {
      const { app } = world;
      const { maintenance } = startWorker(world);
      await seedAround(app);
      expect((await maintenance.runOnce()).failed).toBe(0);
      await expectLeft(app, boundaryRow);

      await setConfig(app, daysKey(table), '200');
      for (const other of PURGED_TABLES) await seedRow(app, other, shift(boundary(other), -1));
      await seedRow(app, table, shift(CUTOFF_200, -1));
      await seedRow(app, table, CUTOFF_200);
      expect((await maintenance.runOnce()).failed).toBe(0);
      await expectLeft(app, (each) =>
        each === table
          ? [CUTOFF_200, shift(boundary(table), -1), boundary(table)]
          : [boundary(each)],
      );
    });
  },
  60_000,
);

it('[AC-B1-15zb#12] retention.purge.enabled 为 false：六张表都不清，其他维护照常；改回 true 后清理，couli_maint 仍写不了配置', async () => {
  await withWorld(async (world) => {
    const { app, maint } = world;
    await seedAround(app);
    await seedExpiredOpenAttempt(app);
    await setConfig(app, 'retention.purge.enabled', 'false');
    const { maintenance, lines } = startWorker(world);

    const off = await maintenance.runOnce();
    expect(off.failed).toBe(0);
    expect(off.ensured).toHaveLength(ALL_ENSURED);
    await expectLeft(app, bothRows);
    expect(await countRows(app, 'link_open_attempts')).toBe(0n);
    expect(retentionLines(lines)).toEqual([]);
    expect(lines.map(reduceLine).at(-1)).toEqual(done(ALL_ENSURED, 0, 0));
    expect(
      await sqlState(sql`UPDATE app.config_items SET updated_by = 'maint'`.execute(maint)),
    ).toBe('42501');

    await setConfig(app, 'retention.purge.enabled', 'true');
    expect((await maintenance.runOnce()).failed).toBe(0);
    await expectLeft(app, boundaryRow);
  });
}, 60_000);

it('[AC-B1-15zb#13] 多于一批的到期行分批删到 0，只写一行合计', async () => {
  await withWorld(async (world) => {
    const { app } = world;
    const cutoff = CUTOFF[180];
    await seedLoginLogs(app, 2 * BATCH_SIZE + 500, shift(cutoff, -1));
    await seedRow(app, 'login_logs', cutoff);
    const { maintenance, lines } = startWorker(world);
    expect((await maintenance.runOnce()).failed).toBe(0);
    // 先比行数：数组差异太大时 toEqual 生成 diff 很慢。
    expect(await countRows(app, 'login_logs')).toBe(1n);
    expect(await times(app, 'login_logs')).toEqual([cutoff]);
    expect(retentionLines(lines)).toEqual([
      line('info', 'retention_purged', { table: 'login_logs', rows: 2 * BATCH_SIZE + 500 }),
    ]);
  });
}, 120_000);

it('[AC-B1-15zb#14] 做满批数上限还有积压：本轮停下记 backlog，最新的行留到下一轮再删', async () => {
  await withWorld(async (world) => {
    const { app } = world;
    const cutoff = CUTOFF[180];
    const newestExpired = shift(cutoff, -1);
    const limit = MAX_BATCHES * BATCH_SIZE;
    await seedLoginLogs(app, limit + 1, newestExpired);
    await seedRow(app, 'login_logs', cutoff);
    const { maintenance, lines } = startWorker(world);

    expect((await maintenance.runOnce()).failed).toBe(0);
    expect(await countRows(app, 'login_logs')).toBe(2n);
    expect(await times(app, 'login_logs')).toEqual([newestExpired, cutoff]);
    expect(retentionLines(lines)).toEqual([
      line('warn', 'retention_purge_backlog', { table: 'login_logs', rows: limit }),
    ]);

    lines.length = 0;
    expect((await maintenance.runOnce()).failed).toBe(0);
    expect(await times(app, 'login_logs')).toEqual([cutoff]);
    expect(retentionLines(lines)).toEqual([
      line('info', 'retention_purged', { table: 'login_logs', rows: 1 }),
    ]);
  });
}, 120_000);

it.each(['notify_logs', 'deleted_identities'] as const)(
  '[AC-B1-15zb#15] %s 拿不到表锁：只这张表失败（55P03），其他五张照删，维护继续，下一轮补上',
  async (locked) => {
    await withWorld(async (world) => {
      const { app, database } = world;
      await seedAround(app);
      const { maintenance, lines } = startWorker(world);
      const lock = holdLock(database, (trx) =>
        sql`LOCK TABLE ${sql.table(`app.${locked}`)} IN ACCESS EXCLUSIVE MODE`.execute(trx),
      );
      const others = PURGED_TABLES.filter((table) => table !== locked);
      try {
        await lock.ready;
        const report = await maintenance.runOnce();
        expect(report.failed).toBe(1);
        expect(report.ensured).toHaveLength(ALL_ENSURED);
      } finally {
        lock.release();
        await lock.done;
      }
      await expectLeft(app, (table) => (table === locked ? bothRows(table) : boundaryRow(table)));
      const written = retentionLines(lines);
      expect(written).toHaveLength(PURGED_TABLES.length);
      expect(written).toEqual(
        expect.arrayContaining([
          line('error', 'retention_purge_failed', { table: locked, sqlstate: '55P03' }),
          ...others.map((table) => line('info', 'retention_purged', { table, rows: 1 })),
        ]),
      );
      expect(lines.map(reduceLine).at(-1)).toEqual(done(ALL_ENSURED, 0, 1));

      lines.length = 0;
      expect((await maintenance.runOnce()).failed).toBe(0);
      await expectLeft(app, boundaryRow);
      expect(retentionLines(lines)).toEqual([
        line('info', 'retention_purged', { table: locked, rows: 1 }),
      ]);
    });
  },
  60_000,
);

/** UUID、32 位以上十六进制（设备、手机号摘要）、夹具 IP。 */
const PERSONAL = /[0-9a-f]{8}-[0-9a-f]{4}-|[0-9a-f]{32}|192\.0\.2\./;

it('[AC-B1-15zb#16] 报告形状与计数不变，日志只有表名与删除行数，没有删除时不多出日志行', async () => {
  await withWorld(async (world) => {
    await seedAround(world.app);
    const { maintenance, lines } = startWorker(world);

    const report = await maintenance.runOnce();
    expect(Object.keys(report).sort()).toEqual(['defaultRows', 'dropped', 'ensured', 'failed']);
    expect(report).toMatchObject({ dropped: [], defaultRows: [], failed: 0 });
    expect(report.ensured).toHaveLength(ALL_ENSURED);
    const written = lines.map(reduceLine);
    expect(written).toHaveLength(PURGED_TABLES.length + 1);
    expect(written).toEqual(
      expect.arrayContaining(
        PURGED_TABLES.map((table) => line('info', 'retention_purged', { table, rows: 1 })),
      ),
    );
    expect(written.at(-1)).toEqual(done(ALL_ENSURED, 0, 0));
    expect(lines.filter((raw) => PERSONAL.test(raw))).toEqual([]);

    lines.length = 0;
    expect((await maintenance.runOnce()).failed).toBe(0);
    expect(lines.map(reduceLine)).toEqual([done(ALL_ENSURED, 0, 0)]);
  });
}, 60_000);

it('[AC-B1-15zb#17] order_sync_drop_keys 与 blocklist 本批不清：同一轮里再旧的行也留着（D10-457、D10-454）', async () => {
  await withWorld(async (world) => {
    const { app } = world;
    const longAgo = '2025-01-01T00:00:00.000Z';
    await seedAround(app);
    await sql`
      INSERT INTO app.order_sync_drop_keys (app_id, platform, sub_order_id, reason, created_at)
      VALUES ('couli', 'taobao', 'spec-sub-order', 'spec-reason', ${longAgo}::timestamptz)
    `.execute(app);
    await sql`
      INSERT INTO app.blocklist
        (id, app_id, dimension, value_hmac, violation_type, expire_at, status, created_by,
         created_at)
      VALUES (${randomUUID()}, 'couli', 'phone', ${randomBytes(32).toString('hex')}, 'other',
        ${longAgo}::timestamptz, 'active', 'spec', ${longAgo}::timestamptz)
    `.execute(app);
    const { maintenance } = startWorker(world);
    expect((await maintenance.runOnce()).failed).toBe(0);
    await expectLeft(app, boundaryRow);
    expect(await countRows(app, 'order_sync_drop_keys')).toBe(1n);
    expect(await countRows(app, 'blocklist')).toBe(1n);
  });
}, 60_000);

it('[AC-B1-15zb#18] notify_logs 的 inbox、push、sms 三个渠道同按 190 天：到期行都删，分界上的行都留（⑥⑯）', async () => {
  await withWorld(async (world) => {
    const { app } = world;
    const cutoff = boundary('notify_logs');
    for (const channel of NOTIFY_CHANNELS) {
      await seedNotifyLog(app, channel, shift(cutoff, -1));
      await seedNotifyLog(app, channel, cutoff);
    }
    const { maintenance, lines } = startWorker(world);
    expect((await maintenance.runOnce()).failed).toBe(0);
    expect(await notifyRows(app)).toEqual(
      NOTIFY_CHANNELS.map((channel) => ({ channel, at: cutoff })),
    );
    expect(retentionLines(lines)).toEqual([
      line('info', 'retention_purged', { table: 'notify_logs', rows: NOTIFY_CHANNELS.length }),
    ]);
  });
}, 60_000);
