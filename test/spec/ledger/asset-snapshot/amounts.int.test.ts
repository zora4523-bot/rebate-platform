import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { immutableState } from '../daily-check/kit.ts';
import {
  APP,
  DAY,
  NOMINAL,
  OTHER,
  TIMEOUT,
  account,
  balance,
  daily,
  entry,
  inDatabase,
  input,
  pair,
  platform,
  receivables,
  setup,
  snapshots,
  totals,
  voucher,
} from './kit.ts';

it(
  '[AC-B2-04w#1] 按账户先净额再分正负，冻结独立；以凭证会计日截断而非缓存或记账时刻',
  async () => {
    const { runner } = setup();
    await inDatabase(createTestDatabase, async (db) => {
      const positive = await account(db, { app_id: APP });
      const negative = await account(db, { app_id: APP });
      const zero = await account(db, { app_id: APP });
      const idle = await account(db, { app_id: APP });
      const union = await platform(db, 'UNION_RECEIVABLE:taobao', APP);
      const old = await voucher(db, { app_id: APP, accounting_date: '2032-05-31' });
      const day = await voucher(db, { app_id: APP, accounting_date: DAY });
      const future = await voucher(db, { app_id: APP, accounting_date: '2032-06-16' });
      await pair(db, positive, union, old, -1000n);
      await pair(db, positive, union, day, 250n, { ledger_type: 'CLAWBACK', account_version: 2n });
      await pair(db, negative, union, old, -100n);
      await pair(db, negative, union, day, 400n, { ledger_type: 'CLAWBACK', account_version: 2n });
      await pair(db, zero, union, day, -50n);
      await pair(db, zero, union, day, 50n, { ledger_type: 'CLAWBACK', account_version: 2n });
      await pair(db, positive, union, day, -80n, { sub_account: 'frozen', account_version: 3n });
      await pair(db, positive, union, day, 20n, {
        sub_account: 'frozen',
        ledger_type: 'WITHDRAW_RETURN',
        account_version: 4n,
      });
      await pair(db, negative, union, day, -40n, { sub_account: 'frozen', account_version: 3n });
      // Historical accounting date, deliberately booked after the cutoff: it still belongs to D.
      await pair(db, positive, union, day, -7n, {
        booked_at: '2032-06-16T03:00:00Z',
        account_version: 5n,
      });
      // Future accounting date, despite an earlier booked_at: it must be excluded.
      await pair(db, positive, union, future, -900n, { account_version: 6n });
      await balance(db, positive, 888888n, 22222n);
      await balance(db, negative, 33333n, 44444n);
      await balance(db, idle, 99999n);
      await daily(db, positive, { closing_fen: -777777n, credit_fen: 777777n });
      const before = await immutableState(db);
      const result = await runner.run(db, input());
      expect(result.accountingDate).toBe(DAY);
      expect(await snapshots(db)).toEqual([
        expect.objectContaining({
          id: result.snapshotId,
          app_id: APP,
          day: DAY,
          total_available_positive_fen: 757n,
          total_negative_fen: 300n,
          total_frozen_fen: 100n,
          total_waiting_fen: 0n,
          total_estimated_fen: 0n,
          waiting_comparable: true,
        }),
      ]);
      expect(await receivables(db)).toEqual([
        {
          asset_snapshot_id: result.snapshotId,
          app_id: APP,
          platform: 'taobao',
          union_receivable_fen: 557n,
        },
      ]);
      expect(await immutableState(db)).toEqual(before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#2] 应收按平台取借正贷负净额，回款冲减；现金和其他平台科目不计入',
  async () => {
    const { runner } = setup();
    await inDatabase(createTestDatabase, async (db) => {
      const taobao = await platform(db, 'UNION_RECEIVABLE:taobao', APP);
      const jd = await platform(db, 'UNION_RECEIVABLE:jd', APP);
      const vip = await platform(db, 'UNION_RECEIVABLE:vip', APP);
      const cash = await platform(db, 'CASH_ALIPAY', APP);
      const expense = await platform(db, 'MKT_EXPENSE', APP);
      const v = await voucher(db, { app_id: APP });
      await entry(db, taobao, v, 1200n);
      await entry(db, taobao, v, -1150n);
      await entry(db, jd, v, 30n);
      await entry(db, jd, v, -40n);
      await entry(db, vip, v, 70n);
      await entry(db, cash, v, 1150n);
      await entry(db, expense, v, 9999n);
      await entry(
        db,
        taobao,
        await voucher(db, { app_id: APP, accounting_date: '2032-06-16' }),
        888n,
      );
      const result = await runner.run(db, input());
      const rows = await receivables(db);
      expect(rows.map((r) => ({ platform: r.platform, amount: r.union_receivable_fen }))).toEqual([
        { platform: 'jd', amount: -10n },
        { platform: 'taobao', amount: 50n },
        { platform: 'vip', amount: 70n },
      ]);
      expect(rows.every((r) => r.asset_snapshot_id === result.snapshotId && r.app_id === APP)).toBe(
        true,
      );
      expect(await snapshots(db)).toEqual([
        expect.objectContaining({
          total_available_positive_fen: 0n,
          total_negative_fen: 0n,
          total_frozen_fen: 0n,
        }),
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#3] 分录、余额、预估与应收都按 app 隔离；同一用户标识不会串账',
  async () => {
    const { runner, readAppTotals } = setup();
    readAppTotals.mockImplementation((_db, selection) =>
      Promise.resolve(selection.appId === APP ? totals(101n, 202n) : totals(9001n, 9002n)),
    );
    await inDatabase(createTestDatabase, async (db) => {
      const a = await account(db, { app_id: APP });
      const b = await account(db, { app_id: OTHER, owner_id: a.owner_id });
      const pa = await platform(db, 'UNION_RECEIVABLE:taobao', APP);
      const pb = await platform(db, 'UNION_RECEIVABLE:taobao', OTHER);
      await pair(db, a, pa, await voucher(db, { app_id: APP, uniq_key: 'same-event' }), -60n);
      await pair(db, b, pb, await voucher(db, { app_id: OTHER, uniq_key: 'same-event' }), -800n);
      await runner.run(db, input());
      expect(await snapshots(db, OTHER)).toEqual([]);
      expect(await receivables(db, OTHER)).toEqual([]);
      const first = await snapshots(db);
      await runner.run(db, input(OTHER));
      expect(await snapshots(db)).toEqual(first);
      expect(first).toEqual([
        expect.objectContaining({
          total_available_positive_fen: 60n,
          total_waiting_fen: 101n,
          total_estimated_fen: 202n,
        }),
      ]);
      expect(await snapshots(db, OTHER)).toEqual([
        expect.objectContaining({
          total_available_positive_fen: 800n,
          total_waiting_fen: 9001n,
          total_estimated_fen: 9002n,
        }),
      ]);
      expect((await receivables(db))[0]?.union_receivable_fen).toBe(60n);
      expect((await receivables(db, OTHER))[0]?.union_receivable_fen).toBe(800n);
      expect(readAppTotals.mock.calls.map((call) => call[1])).toEqual([
        { appId: APP },
        { appId: OTHER },
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#4] 超过安全整数仍保留一分钱：余额、负余额、冻结、应收与预估全部为精确整数分',
  async () => {
    const { runner, readAppTotals } = setup();
    readAppTotals.mockResolvedValue(totals(9007199254740993n, 9007199254740995n));
    await inDatabase(createTestDatabase, async (db) => {
      const a = await account(db, { app_id: APP });
      const b = await account(db, { app_id: APP });
      const union = await platform(db, 'UNION_RECEIVABLE:taobao', APP);
      const v = await voucher(db, { app_id: APP });
      await entry(db, a, v, -9007199254740994n);
      await entry(db, a, v, 1n, { ledger_type: 'CLAWBACK', account_version: 2n });
      await entry(db, b, v, 9007199254740993n);
      await entry(db, a, v, -9007199254740993n, { sub_account: 'frozen', account_version: 3n });
      await entry(db, union, v, 9007199254740994n);
      await entry(db, union, v, -1n);
      await runner.run(db, input());
      expect(await snapshots(db)).toEqual([
        expect.objectContaining({
          total_available_positive_fen: 9007199254740993n,
          total_negative_fen: 9007199254740993n,
          total_frozen_fen: 9007199254740993n,
          total_waiting_fen: 9007199254740993n,
          total_estimated_fen: 9007199254740995n,
        }),
      ]);
      expect((await receivables(db))[0]?.union_receivable_fen).toBe(9007199254740993n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04w#5] 空账本仍写快照，预估经 app 端口覆盖尚未开户者，运行时取值不套 D 日截断',
  async () => {
    const { runner, clock, readAppTotals, readUser } = setup();
    readAppTotals.mockResolvedValue(totals(925n, 123n));
    clock.set('2032-06-15T16:09:00.000Z');
    // State changes between nominal scheduling and delivery must be reflected by the source.
    readAppTotals.mockResolvedValue(totals(617n, 0n));
    await inDatabase(createTestDatabase, async (db) => {
      await runner.run(db, input());
      expect(readAppTotals).toHaveBeenCalledTimes(1);
      expect(readAppTotals.mock.calls[0]?.[1]).toEqual({ appId: APP });
      expect(readUser).not.toHaveBeenCalled();
      const rows = await snapshots(db);
      expect(rows).toEqual([
        expect.objectContaining({
          day: DAY,
          total_available_positive_fen: 0n,
          total_negative_fen: 0n,
          total_frozen_fen: 0n,
          total_waiting_fen: 617n,
          total_estimated_fen: 0n,
          waiting_comparable: true,
        }),
      ]);
      expect(rows[0]?.created_at.toISOString()).toBe('2032-06-15T16:09:00.000Z');
      expect(rows[0]?.updated_at.toISOString()).toBe('2032-06-15T16:09:00.000Z');
      expect(await receivables(db)).toEqual([]);
      expect(NOMINAL).not.toBe(rows[0]?.created_at.toISOString());
    });
  },
  TIMEOUT,
);
