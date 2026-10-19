import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  APP,
  DAY,
  OTHER,
  TIMEOUT,
  account,
  balance,
  entry,
  immutableState,
  inDatabase,
  invariantFiles,
  pair,
  platform,
  setup,
  voucher,
} from './kit.ts';

it(
  '[AC-B2-02j#15] 外应用的全局差异不能使指定 appId 收到关闭月结建议或差异告警',
  async () => {
    const { runner, logs } = setup();
    await inDatabase(createTestDatabase, async (db) => {
      const p = await platform(db, 'UNION_RECEIVABLE:taobao', OTHER);
      await entry(db, p, await voucher(db, { app_id: OTHER }), 1n);
      const result = await runner.runDailyCheck(db, { appId: APP, accountingDate: DAY });
      expect(result.accountDifferences).toEqual([]);
      expect(result.globalDifferences).toEqual([]);
      expect(result.checks.find((c) => c.invariant === '02')?.checkedRows).toBe(1n);
      expect(result.emptyChecks).not.toContain('02');
      expect(result.recommendations).toEqual({
        createDiscrepancies: false,
        freezeWithdrawals: false,
        disableAutoSettlement: false,
      });
      expect(logs.some((l) => l.fields['scope'] === 'global' || l.fields['app_id'] === OTHER)).toBe(
        false,
      );
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02j#6] 默认加载全部 SQL；干净数据零差异，逐不变量报告检查行数',
  async () => {
    const { runner, logs } = setup();
    await inDatabase(createTestDatabase, async (db) => {
      const a = await account(db, { app_id: APP });
      const p = await platform(db, 'UNION_RECEIVABLE:taobao', APP);
      await pair(
        db,
        a,
        p,
        await voucher(db, {
          app_id: APP,
          order_key: 'taobao:clean',
          beneficiary_user_id: a.owner_id,
          role: 'self',
          voucher_kind: 'CREDIT',
        }),
        -100n,
      );
      await balance(db, a, 100n);
      const before = await immutableState(db);
      const result = await runner.runDailyCheck(db, { accountingDate: DAY });
      expect(result.checks.map((c) => c.file)).toEqual(invariantFiles().map((f) => f.name));
      expect(result.checks).toEqual([
        { file: '01_user-balances.sql', invariant: '01', checkedRows: 3n },
        { file: '02_voucher-balanced.sql', invariant: '02', checkedRows: 1n },
        { file: '03_credit-unique.sql', invariant: '03', checkedRows: 1n },
        { file: '04_beneficiary-net.sql', invariant: '04', checkedRows: 1n },
        { file: '07_negative-balance-drops.sql', invariant: '07', checkedRows: 1n },
      ]);
      expect(result.accountDifferences).toEqual([]);
      expect(result.globalDifferences).toEqual([]);
      expect(result.emptyChecks).toEqual([]);
      expect(result.recommendations).toEqual({
        createDiscrepancies: false,
        freezeWithdrawals: false,
        disableAutoSettlement: false,
      });
      expect(logs).toEqual([]);
      expect(await immutableState(db)).toEqual(before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02j#7] 账户两个子户的差异完整保留、结构化告警，不升级为全局处置',
  async () => {
    const { runner, logs } = setup();
    await inDatabase(createTestDatabase, async (db) => {
      const a = await account(db, { app_id: APP });
      await pair(
        db,
        a,
        await platform(db, 'UNION_RECEIVABLE:taobao', APP),
        await voucher(db, { app_id: APP }),
        -100n,
      );
      await balance(db, a, 99n, 1n);
      const before = await immutableState(db);
      const result = await runner.runDailyCheck(db, { accountingDate: DAY });
      expect(result.accountDifferences).toHaveLength(2);
      expect(result.accountDifferences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            invariant: '01',
            scope: 'account',
            app_id: APP,
            account_id: a.id,
            detail: expect.objectContaining({
              check: 'balance_cache',
              sub_account: 'available',
              cache_fen: '99',
              expected_cache_fen: '100',
            }),
          }),
          expect.objectContaining({
            invariant: '01',
            scope: 'account',
            app_id: APP,
            account_id: a.id,
            detail: expect.objectContaining({
              check: 'balance_cache',
              sub_account: 'frozen',
              cache_fen: '1',
              expected_cache_fen: '0',
            }),
          }),
        ]),
      );
      expect(result.checks.find((c) => c.invariant === '01')?.checkedRows).toBe(3n);
      expect(result.globalDifferences).toEqual([]);
      expect(result.recommendations).toEqual({
        createDiscrepancies: true,
        freezeWithdrawals: true,
        disableAutoSettlement: false,
      });
      expect(logs.map((l) => l.fields)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            invariant: '01',
            scope: 'account',
            app_id: APP,
            account_id: a.id,
            accounting_date: DAY,
          }),
        ]),
      );
      expect(await immutableState(db)).toEqual(before); // No automatic cache repair.
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02j#8] 全局 ②③④ 差异逐行保留、检查数不按差异倍增，只返回关闭月结和冻结建议',
  async () => {
    const { runner, logs } = setup();
    await inDatabase(createTestDatabase, async (db) => {
      const a = await account(db, { app_id: APP });
      const p = await platform(db, 'UNION_RECEIVABLE:taobao', APP);
      const key = {
        app_id: APP,
        order_key: 'taobao:duplicate',
        beneficiary_user_id: a.owner_id,
        role: 'self',
      };
      // Legal INSERT fixtures model two opposite voucher errors without disabling any guard.
      const first = await voucher(db, { ...key, voucher_kind: 'CREDIT' });
      await entry(db, a, first, -100n);
      await entry(db, p, first, 101n);
      const second = await voucher(db, { ...key, voucher_kind: 'CREDIT' });
      await entry(db, a, second, -100n, { account_version: 2n, balance_after_fen: 200n });
      await entry(db, p, second, 99n);
      await pair(db, a, p, await voucher(db, { ...key, voucher_kind: 'CLAWBACK' }), 250n, {
        ledger_type: 'CLAWBACK',
        account_version: 3n,
        balance_after_fen: -50n,
      });
      await balance(db, a, -50n);
      const before = await immutableState(db);
      const result = await runner.runDailyCheck(db, { accountingDate: DAY });
      expect(result.accountDifferences).toEqual([]);
      expect(result.globalDifferences).toHaveLength(4);
      expect(result.globalDifferences.map((d) => d.invariant).sort()).toEqual([
        '02',
        '02',
        '03',
        '04',
      ]);
      expect(result.globalDifferences.every((d) => d.scope === 'global' && d.app_id === APP)).toBe(
        true,
      );
      expect(result.globalDifferences).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            invariant: '02',
            detail: expect.objectContaining({
              voucher_id: first.id,
              actual_sum_fen: '1',
            }),
          }),
          expect.objectContaining({
            invariant: '02',
            detail: expect.objectContaining({
              voucher_id: second.id,
              actual_sum_fen: '-1',
            }),
          }),
          expect.objectContaining({
            invariant: '04',
            detail: expect.objectContaining({ net_fen: '-50' }),
          }),
        ]),
      );
      expect(result.checks.map((c) => [c.invariant, c.checkedRows])).toEqual([
        ['01', 3n],
        ['02', 3n],
        ['03', 1n],
        ['04', 1n],
        ['07', 3n],
      ]);
      expect(result.recommendations).toEqual({
        createDiscrepancies: true,
        freezeWithdrawals: true,
        disableAutoSettlement: true,
      });
      for (const invariant of ['02', '03', '04']) {
        expect(logs.map((l) => l.fields)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              invariant,
              scope: 'global',
              app_id: APP,
              accounting_date: DAY,
            }),
          ]),
        );
      }
      expect(await immutableState(db)).toEqual(before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02j#9] 全空数据库逐文件记空检告警，不能当作全局差异或冻结理由',
  async () => {
    const { runner, logs } = setup();
    await inDatabase(createTestDatabase, async (db) => {
      const result = await runner.runDailyCheck(db, { accountingDate: DAY });
      expect(result.checks.map((c) => c.checkedRows)).toEqual([0n, 0n, 0n, 0n, 0n]);
      expect(result.emptyChecks).toEqual(['01', '02', '03', '04', '07']);
      expect(result.accountDifferences).toEqual([]);
      expect(result.globalDifferences).toEqual([]);
      expect(result.recommendations).toEqual({
        createDiscrepancies: false,
        freezeWithdrawals: false,
        disableAutoSettlement: false,
      });
      for (const invariant of result.emptyChecks) {
        expect(logs.map((l) => l.fields)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: 'ledger_daily_check_empty',
              invariant,
              checked_rows: '0',
              accounting_date: DAY,
            }),
          ]),
        );
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02j#10] ⑦ 非法负余额下降归账户级，appId 过滤差异与告警但检查数保留 SQL 原值',
  async () => {
    const { runner, logs } = setup();
    await inDatabase(createTestDatabase, async (db) => {
      for (const appId of [APP, OTHER]) {
        const a = await account(db, { app_id: appId });
        await pair(
          db,
          a,
          await platform(db, 'UNION_RECEIVABLE:taobao', appId),
          await voucher(db, { app_id: appId }),
          80n,
          { ledger_type: 'WITHDRAW_PAID' },
        );
        await balance(db, a, -80n);
      }
      // Create both tenants' snapshots first to isolate the reporting filter from missing snapshots.
      await runner.runDailyCheck(db, { accountingDate: DAY });
      logs.length = 0;
      const result = await runner.runDailyCheck(db, { appId: APP, accountingDate: DAY });
      expect(result.accountDifferences).toEqual([
        expect.objectContaining({
          invariant: '07',
          scope: 'account',
          app_id: APP,
          account_id: expect.any(String),
          detail: expect.objectContaining({ ledger_type: 'WITHDRAW_PAID' }),
        }),
      ]);
      expect(result.globalDifferences).toEqual([]);
      expect(result.checks.find((c) => c.invariant === '07')?.checkedRows).toBe(2n);
      expect(logs.some((l) => l.fields['app_id'] === OTHER)).toBe(false);
      expect(result.recommendations.disableAutoSettlement).toBe(false);
    });
  },
  TIMEOUT,
);
