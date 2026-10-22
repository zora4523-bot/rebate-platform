import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  createAssetSnapshot,
  getAssetSnapshotStatus,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  APP,
  DAY,
  DEADLINE,
  OTHER,
  TIMEOUT,
  alerts,
  entry,
  inDatabase,
  input,
  platform,
  receivables,
  setup,
  snapshots,
  voucher,
} from './kit.ts';

it(
  '[AC-B2-04w#16] 垫资告警按平台合计严格大于阈值，每 app 每日一次，并发和新实例重跑不重复',
  async () => {
    const { runner, dependencies, logger, getAdvanceAlertFen, clock } = setup(undefined, 100n);
    await inDatabase(createTestDatabase, async (db) => {
      for (const name of ['taobao', 'jd']) {
        const a = await platform(db, `UNION_RECEIVABLE:${name}`, APP);
        await entry(db, a, await voucher(db, { app_id: APP }), 60n);
      }
      await Promise.all([
        runner.run(db, input()),
        createAssetSnapshot(dependencies).run(db, input()),
        createAssetSnapshot(dependencies).run(db, input()),
      ]);
      await createAssetSnapshot(dependencies).run(db, input());
      expect(alerts(logger, 'ledger_advance_exposure')).toEqual([
        expect.objectContaining({
          app_id: APP,
          accounting_date: DAY,
          union_receivable_fen: '120',
          advance_alert_fen: '100',
        }),
      ]);
      expect(getAdvanceAlertFen.mock.calls.every(([appId]) => appId === APP)).toBe(true);
      // The balance persists without new entries: tomorrow must alert again.
      clock.set('2032-06-16T16:01:00.000Z');
      await runner.run(db, input(APP, '2032-06-16T16:01:00.000Z'));
      expect(alerts(logger, 'ledger_advance_exposure')).toHaveLength(2);
      expect(alerts(logger, 'ledger_advance_exposure')[1]).toMatchObject({
        app_id: APP,
        accounting_date: '2032-06-16',
      });
      expect(await snapshots(db)).toHaveLength(2);
      expect(await receivables(db)).toHaveLength(4);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#17] 未配置、低于或等于阈值不告警，仍保存资产快照；负平台净额须参与合计',
  async () => {
    const { runner, logger, getAdvanceAlertFen } = setup();
    await inDatabase(createTestDatabase, async (db) => {
      for (const appId of [APP, OTHER, 'asset-equal', 'asset-below']) {
        const taobao = await platform(db, 'UNION_RECEIVABLE:taobao', appId);
        const jd = await platform(db, 'UNION_RECEIVABLE:jd', appId);
        const v = await voucher(db, { app_id: appId });
        await entry(db, taobao, v, 120n);
        await entry(db, jd, v, -20n);
      }
      // Unconfigured: even a positive exposure must not send a finance alert.
      await runner.run(db, input());
      expect(await snapshots(db)).toHaveLength(1);
      expect(alerts(logger, 'ledger_advance_exposure')).toEqual([]);
      getAdvanceAlertFen.mockResolvedValue(100n);
      await runner.run(db, input('asset-equal'));
      getAdvanceAlertFen.mockResolvedValue(101n);
      await runner.run(db, input('asset-below'));
      expect(await snapshots(db, 'asset-equal')).toHaveLength(1);
      expect(await snapshots(db, 'asset-below')).toHaveLength(1);
      expect(alerts(logger, 'ledger_advance_exposure')).toEqual([]);
      // Zero is configured, not an absent threshold. App-local alert key must not collide.
      getAdvanceAlertFen.mockResolvedValue(0n);
      await runner.run(db, input(OTHER));
      expect(alerts(logger, 'ledger_advance_exposure')).toEqual([
        expect.objectContaining({
          app_id: OTHER,
          accounting_date: DAY,
          union_receivable_fen: '100',
          advance_alert_fen: '0',
        }),
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#18] 阈值比较保留大整数的一分之差，并只计算 D 日截止的应收',
  async () => {
    const { runner, logger } = setup(undefined, 9007199254740992n);
    await inDatabase(createTestDatabase, async (db) => {
      const union = await platform(db, 'UNION_RECEIVABLE:taobao', APP);
      await entry(db, union, await voucher(db, { app_id: APP }), 9007199254740993n);
      await entry(
        db,
        union,
        await voucher(db, { app_id: APP, accounting_date: '2032-06-16' }),
        -9007199254740993n,
      );
      await runner.run(db, input());
      expect(alerts(logger, 'ledger_advance_exposure')).toEqual([
        expect.objectContaining({
          app_id: APP,
          accounting_date: DAY,
          union_receivable_fen: '9007199254740993',
          advance_alert_fen: '9007199254740992',
        }),
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#19] 快照写入回滚不能预先发送垫资成功告警，重试成功后再发一次',
  async () => {
    const { runner, readAppTotals, logger } = setup(undefined, 1n);
    await inDatabase(createTestDatabase, async (db) => {
      const union = await platform(db, 'UNION_RECEIVABLE:taobao', APP);
      await entry(db, union, await voucher(db, { app_id: APP }), 50n);
      readAppTotals.mockRejectedValueOnce(new Error('source failed'));
      await expect(runner.run(db, input())).rejects.toThrow();
      expect(await snapshots(db)).toEqual([]);
      expect(alerts(logger, 'ledger_advance_exposure')).toEqual([]);
      await runner.run(db, input());
      expect(alerts(logger, 'ledger_advance_exposure')).toHaveLength(1);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#20] 超时仍读取失败则告警且不伪造完成行，等待者通过只读口获知超时',
  async () => {
    const { runner, clock, readAppTotals, logger } = setup(DEADLINE);
    readAppTotals.mockRejectedValueOnce(new Error('source still unavailable'));
    await inDatabase(createTestDatabase, async (db, reader) => {
      await expect(runner.run(db, input())).rejects.toThrow();
      expect(await snapshots(db)).toEqual([]);
      expect(alerts(logger, 'asset_snapshot_timeout')).toEqual(
        expect.arrayContaining([expect.objectContaining({ app_id: APP, accounting_date: DAY })]),
      );
      expect(
        await getAssetSnapshotStatus(reader, { appId: APP, accountingDate: DAY }, clock),
      ).toEqual({ state: 'timed_out', snapshotId: null, waitingComparable: null });
    });
  },
  TIMEOUT,
);
