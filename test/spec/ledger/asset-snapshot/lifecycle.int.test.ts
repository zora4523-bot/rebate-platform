import { createTestDatabase } from '@couli/db/testing';
import { TableNode } from 'kysely';
import { expect, it } from 'vitest';
import {
  createAssetSnapshot,
  getAssetSnapshotStatus,
  type PendingEarningsTotals,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  APP,
  DAY,
  DEADLINE,
  NOMINAL,
  OTHER,
  TIMEOUT,
  alerts,
  entry,
  existingSnapshot,
  failReceivableWrite,
  inDatabase,
  input,
  platform,
  receivables,
  setup,
  snapshots,
  totals,
  voucher,
} from './kit.ts';

it(
  '[AC-B2-04w#21] 预估读取悬而未决时不暴露完成行；独立读连接到截止线即可返回超时',
  async () => {
    const { runner, clock, readAppTotals, logger } = setup();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<PendingEarningsTotals>();
    readAppTotals.mockImplementation(() => {
      started.resolve();
      return release.promise;
    });
    await inDatabase(createTestDatabase, async (db, reader) => {
      const running = runner.run(db, input());
      try {
        await Promise.race([
          started.promise,
          running.then(() => {
            throw new Error('Snapshot completed without awaiting source');
          }),
        ]);
        expect(await snapshots(reader)).toEqual([]);
        expect(
          await getAssetSnapshotStatus(reader, { appId: APP, accountingDate: DAY }, clock),
        ).toMatchObject({ state: 'pending', snapshotId: null });
        clock.set(DEADLINE);
        expect(
          await getAssetSnapshotStatus(reader, { appId: APP, accountingDate: DAY }, clock),
        ).toMatchObject({ state: 'timed_out', snapshotId: null });
      } finally {
        release.resolve(totals(31n, 41n));
        await running;
      }
      expect(await snapshots(reader)).toEqual([
        expect.objectContaining({
          total_waiting_fen: 31n,
          total_estimated_fen: 41n,
          waiting_comparable: false,
        }),
      ]);
      expect(alerts(logger, 'asset_snapshot_timeout').length).toBeGreaterThan(0);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#6] 按名义 D+1 写 D，延迟跨日、跨年与闰日补跑不能改用实际当天',
  async () => {
    const { runner } = setup('2033-01-03T16:05:00.000Z');
    await inDatabase(createTestDatabase, async (db) => {
      for (const [nominal, expectedDay] of [
        ['2032-02-29T16:01:00.000Z', '2032-02-29'],
        ['2032-12-31T16:01:00.000Z', '2032-12-31'],
        ['2031-12-31T16:01:00.000Z', '2031-12-31'],
      ]) {
        const result = await runner.run(db, input(APP, nominal));
        expect(result.accountingDate).toBe(expectedDay);
      }
      expect((await snapshots(db)).map((row) => row.day)).toEqual([
        '2031-12-31',
        '2032-02-29',
        '2032-12-31',
      ]);
      expect((await snapshots(db)).every((row) => !row.waiting_comparable)).toBe(true);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#7] 同日重跑和新运行器重放返回同一快照，预估变化不改写历史金额与时间',
  async () => {
    const { runner, dependencies, readAppTotals, clock, logger } = setup();
    readAppTotals.mockResolvedValue(totals(100n, 200n));
    await inDatabase(createTestDatabase, async (db) => {
      const union = await platform(db, 'UNION_RECEIVABLE:taobao', APP);
      await entry(db, union, await voucher(db, { app_id: APP }), 700n);
      const first = await runner.run(db, input());
      const before = await snapshots(db);
      const children = await receivables(db);
      // D10-191：截止前写入并确认后才可比；迟到重放不得撤销确认或重写历史。
      expect(before).toEqual([expect.objectContaining({ waiting_comparable: true })]);
      readAppTotals.mockRejectedValue(
        new Error('The source is unavailable after first completion'),
      );
      clock.set('2032-06-15T16:45:00.000Z');
      const restarted = createAssetSnapshot(dependencies);
      expect(await restarted.run(db, input())).toEqual(first);
      expect(await runner.run(db, input())).toEqual(first);
      expect(await snapshots(db)).toEqual(before);
      expect(await receivables(db)).toEqual(children);
      expect(readAppTotals).toHaveBeenCalledTimes(1);
      expect(alerts(logger, 'asset_snapshot_timeout')).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#8] 独立运行器并发投递只有一个父快照及每平台一条子记录',
  async () => {
    const { dependencies, readAppTotals } = setup();
    readAppTotals.mockResolvedValue(totals(11n, 22n));
    await inDatabase(createTestDatabase, async (db) => {
      for (const name of ['taobao', 'jd']) {
        const a = await platform(db, `UNION_RECEIVABLE:${name}`, APP);
        await entry(db, a, await voucher(db, { app_id: APP }), 30n);
      }
      const runners = [
        createAssetSnapshot(dependencies),
        createAssetSnapshot(dependencies),
        createAssetSnapshot(dependencies),
      ];
      const results = await Promise.all(runners.map((runner) => runner.run(db, input())));
      expect(new Set(results.map((r) => r.snapshotId)).size).toBe(1);
      expect(await snapshots(db)).toEqual([
        expect.objectContaining({
          id: results[0]?.snapshotId,
          total_waiting_fen: 11n,
          total_estimated_fen: 22n,
        }),
      ]);
      const children = await receivables(db);
      expect(children).toHaveLength(2);
      expect(children.map((r) => r.platform)).toEqual(['jd', 'taobao']);
      expect(
        children.every(
          (r) => r.asset_snapshot_id === results[0]?.snapshotId && r.union_receivable_fen === 30n,
        ),
      ).toBe(true);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#9] 预估读取失败不落半成品，恢复后相同名义任务可重跑',
  async () => {
    const { runner, readAppTotals, clock } = setup();
    readAppTotals.mockRejectedValueOnce(new Error('earnings source unavailable'));
    await inDatabase(createTestDatabase, async (db, reader) => {
      await expect(runner.run(db, input())).rejects.toThrow();
      expect(await snapshots(db)).toEqual([]);
      expect(await receivables(db)).toEqual([]);
      expect(
        await getAssetSnapshotStatus(reader, { appId: APP, accountingDate: DAY }, clock),
      ).toMatchObject({ state: 'pending', snapshotId: null });
      readAppTotals.mockResolvedValue(totals(9n, 8n));
      await runner.run(db, input());
      expect(await snapshots(db)).toEqual([
        expect.objectContaining({ total_waiting_fen: 9n, total_estimated_fen: 8n }),
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#10] 子表写入失败回滚父快照；读口不能把半成品判完成，修复后重跑不重复',
  async () => {
    const { runner, clock } = setup();
    await inDatabase(createTestDatabase, async (db, reader) => {
      const union = await platform(db, 'UNION_RECEIVABLE:taobao', APP);
      await entry(db, union, await voucher(db, { app_id: APP }), 80n);
      const brokenDb = db.withPlugin(
        failReceivableWrite(new Error('injected child write failure')),
      );
      await expect(runner.run(brokenDb, input())).rejects.toThrow();
      expect(await snapshots(db)).toEqual([]);
      expect(await receivables(db)).toEqual([]);
      expect(
        await getAssetSnapshotStatus(reader, { appId: APP, accountingDate: DAY }, clock),
      ).toMatchObject({ state: 'pending' });
      await runner.run(db, input());
      expect(await snapshots(db)).toHaveLength(1);
      expect(await receivables(db)).toEqual([
        expect.objectContaining({ platform: 'taobao', union_receivable_fen: 80n }),
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#11] 只读角色按 app 和 D 判状态：00:30 前未完成，边界超时且不制造快照或任务记录',
  async () => {
    const clock = new FixedClock('2032-06-15T16:00:00.000Z');
    await inDatabase(createTestDatabase, async (db, reader) => {
      await existingSnapshot(db, OTHER);
      await existingSnapshot(db, APP, '2032-06-14');
      const before = await snapshots(db);
      const jobsBefore = await db.selectFrom('settle_jobs').selectAll().execute();
      for (const now of ['2032-06-15T16:00:00.000Z', NOMINAL, '2032-06-15T16:29:59.999Z']) {
        clock.set(now);
        expect(
          await getAssetSnapshotStatus(reader, { appId: APP, accountingDate: DAY }, clock),
        ).toEqual({ state: 'pending', snapshotId: null, waitingComparable: null });
      }
      clock.set(DEADLINE);
      expect(
        await getAssetSnapshotStatus(reader, { appId: APP, accountingDate: DAY }, clock),
      ).toEqual({ state: 'timed_out', snapshotId: null, waitingComparable: null });
      // The deadline belongs to D+1, not to whichever day the read happens on.
      clock.set('2032-06-16T16:01:00.000Z');
      expect(
        await getAssetSnapshotStatus(reader, { appId: APP, accountingDate: DAY }, clock),
      ).toMatchObject({ state: 'timed_out' });
      expect(await snapshots(db)).toEqual(before);
      expect(await db.selectFrom('settle_jobs').selectAll().execute()).toEqual(jobsBefore);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#12] 只依快照行判断完成；无 settle_jobs 与平台子记录亦完成，不可比也不阻塞',
  async () => {
    const clock = new FixedClock(DEADLINE);
    await inDatabase(createTestDatabase, async (db, reader) => {
      const good = await existingSnapshot(db);
      const late = await existingSnapshot(db, OTHER, DAY, false);
      const before = await snapshots(db);
      const otherBefore = await snapshots(db, OTHER);
      for (const now of [NOMINAL, DEADLINE, '2032-06-16T16:01:00.000Z']) {
        clock.set(now);
        expect(
          await getAssetSnapshotStatus(reader, { appId: APP, accountingDate: DAY }, clock),
        ).toEqual({ state: 'complete', snapshotId: good, waitingComparable: true });
        expect(
          await getAssetSnapshotStatus(reader, { appId: OTHER, accountingDate: DAY }, clock),
        ).toEqual({ state: 'complete', snapshotId: late, waitingComparable: false });
      }
      expect(await snapshots(db)).toEqual(before);
      expect(await snapshots(db, OTHER)).toEqual(otherBefore);
      expect(await receivables(db)).toEqual([]);
      expect(await db.selectFrom('settle_jobs').selectAll().execute()).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#13] 00:30 首次落快照已超时：告警、不可比；读口仍返回完成并保留标记',
  async () => {
    const { runner, clock, logger, readAppTotals } = setup(DEADLINE);
    readAppTotals.mockResolvedValue(totals(17n, 23n));
    await inDatabase(createTestDatabase, async (db, reader) => {
      const result = await runner.run(db, input());
      expect(await snapshots(db)).toEqual([
        expect.objectContaining({
          waiting_comparable: false,
          total_waiting_fen: 17n,
          total_estimated_fen: 23n,
        }),
      ]);
      expect(alerts(logger, 'asset_snapshot_timeout')).toEqual(
        expect.arrayContaining([expect.objectContaining({ app_id: APP, accounting_date: DAY })]),
      );
      expect(
        await getAssetSnapshotStatus(reader, { appId: APP, accountingDate: DAY }, clock),
      ).toEqual({ state: 'complete', snapshotId: result.snapshotId, waitingComparable: false });
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#14] 00:30 前开始但取预估期间跨过截止线，完成时必须标不可比并告警',
  async () => {
    const { runner, clock, readAppTotals, logger } = setup('2032-06-15T16:29:59.999Z');
    readAppTotals.mockImplementation(() => {
      clock.set(DEADLINE);
      return Promise.resolve(totals(66n, 77n));
    });
    await inDatabase(createTestDatabase, async (db) => {
      await runner.run(db, input());
      expect(await snapshots(db)).toEqual([
        expect.objectContaining({
          waiting_comparable: false,
          total_waiting_fen: 66n,
          total_estimated_fen: 77n,
        }),
      ]);
      expect(alerts(logger, 'asset_snapshot_timeout').length).toBeGreaterThan(0);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#15] 00:29:59.999 写入并另行确认才可比，迟到的重复投递不得污染原记录',
  async () => {
    const { runner, clock, logger } = setup('2032-06-15T16:29:59.999Z');
    await inDatabase(createTestDatabase, async (db, reader) => {
      // D10-191：首个事务提交 false，确认事务提交前，独立连接仍只能读到 false。
      const confirmations = new WeakSet<object>();
      let unconfirmed: Awaited<ReturnType<typeof snapshots>> | undefined;
      const observedDb = db.withPlugin({
        transformQuery({ node, queryId }) {
          if (
            node.kind === 'UpdateQueryNode' &&
            node.table !== undefined &&
            TableNode.is(node.table) &&
            node.table.table.identifier.name === 'asset_snapshots'
          ) {
            confirmations.add(queryId);
          }
          return node;
        },
        async transformResult({ result, queryId }) {
          if (confirmations.has(queryId)) unconfirmed = await snapshots(reader);
          return result;
        },
      });
      await runner.run(observedDb, input());
      const before = await snapshots(db);
      expect(before).toEqual([expect.objectContaining({ waiting_comparable: true })]);
      expect(unconfirmed).toEqual([
        expect.objectContaining({ id: before[0]?.id, waiting_comparable: false }),
      ]);
      clock.set(DEADLINE);
      await runner.run(db, input());
      expect(await snapshots(db)).toEqual(before);
      expect(alerts(logger, 'asset_snapshot_timeout')).toEqual([]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#22] 写入已提交但确认失败保留不可比，原始错误不被掩盖，截止后读口仍不可比',
  async () => {
    const { runner, clock, readAppTotals } = setup('2032-06-15T16:29:59.999Z');
    readAppTotals.mockResolvedValue(totals(101n, 202n));
    await inDatabase(createTestDatabase, async (db, reader) => {
      const union = await platform(db, 'UNION_RECEIVABLE:taobao', APP);
      await entry(db, union, await voucher(db, { app_id: APP }), 303n);
      const failure = new Error('injected snapshot confirmation failure');
      // D10-191：只破坏后续确认更新；首次写入事务必须已经提交且默认不可比。
      const brokenDb = db.withPlugin({
        transformQuery({ node }) {
          if (
            node.kind === 'UpdateQueryNode' &&
            node.table !== undefined &&
            TableNode.is(node.table) &&
            node.table.table.identifier.name === 'asset_snapshots'
          ) {
            throw failure;
          }
          return node;
        },
        transformResult({ result }) {
          return Promise.resolve(result);
        },
      });
      await expect(runner.run(brokenDb, input())).rejects.toBe(failure);
      const before = await snapshots(reader);
      const children = await receivables(reader);
      expect(before).toEqual([
        expect.objectContaining({
          waiting_comparable: false,
          total_waiting_fen: 101n,
          total_estimated_fen: 202n,
        }),
      ]);
      expect(children).toEqual([
        expect.objectContaining({
          asset_snapshot_id: before[0]?.id,
          platform: 'taobao',
          union_receivable_fen: 303n,
        }),
      ]);
      clock.set(DEADLINE);
      expect(
        await getAssetSnapshotStatus(reader, { appId: APP, accountingDate: DAY }, clock),
      ).toEqual({ state: 'complete', snapshotId: before[0]?.id, waitingComparable: false });
      // 截止后的重放也不能再确认，更不能用新的预估覆盖历史金额与时间。
      readAppTotals.mockRejectedValue(new Error('Replay must not reread earnings'));
      expect(await runner.run(db, input())).toEqual({
        accountingDate: DAY,
        snapshotId: before[0]?.id,
      });
      expect(await snapshots(reader)).toEqual(before);
      expect(await receivables(reader)).toEqual(children);
      expect(readAppTotals).toHaveBeenCalledTimes(1);
    });
  },
  TIMEOUT,
);
