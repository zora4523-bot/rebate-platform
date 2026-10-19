import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  APP,
  DAY,
  NOW,
  OTHER,
  TIMEOUT,
  account,
  balance,
  daily,
  entry,
  immutableState,
  inDatabase,
  pair,
  platform,
  setup,
  snapshots,
  voucher,
} from './kit.ts';

it(
  '[AC-B2-02j#14] 只有前日快照而无任何分录的账户子户也必须结转',
  async () => {
    const { runner } = setup();
    await inDatabase(createTestDatabase, async (db) => {
      const a = await account(db, { app_id: APP });
      const p = await platform(db, 'UNION_RECEIVABLE:taobao', APP);
      await daily(db, a, {
        accounting_date: '2032-06-14',
        sub_account: 'frozen',
        credit_fen: 55n,
        closing_fen: -55n,
      });
      await daily(db, p, {
        accounting_date: '2032-06-14',
        debit_fen: 55n,
        closing_fen: 55n,
      });
      await runner.runDailyCheck(db, { accountingDate: DAY });
      const rows = (await snapshots(db)).filter((r) => r.day === DAY);
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            account_id: a.id,
            sub_account: 'frozen',
            opening_fen: -55n,
            debit_fen: 0n,
            credit_fen: 0n,
            closing_fen: -55n,
          }),
          expect.objectContaining({
            account_id: p.id,
            sub_account: 'available',
            opening_fen: 55n,
            debit_fen: 0n,
            credit_fen: 0n,
            closing_fen: 55n,
          }),
        ]),
      );
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02j#1] 日余额按分录借正贷负，缺前日快照按历史分录求期初，当日发生额排除前后会计日',
  async () => {
    const { runner } = setup();
    await inDatabase(createTestDatabase, async (db) => {
      const a = await account(db, { app_id: APP });
      const p = await platform(db, 'UNION_RECEIVABLE:taobao', APP);
      await balance(db, a, 9999n, 777n); // Deliberately unrelated cache; never a snapshot source.
      await daily(db, a, { accounting_date: '2032-06-14', closing_fen: -1000n, credit_fen: 1000n });
      await daily(db, a, {
        accounting_date: '2032-06-14',
        sub_account: 'frozen',
        closing_fen: -50n,
        credit_fen: 50n,
      });
      const v = await voucher(db, { app_id: APP });
      await pair(db, a, p, v, -200n);
      await pair(db, a, p, v, 70n, { ledger_type: 'CLAWBACK', account_version: 2n });
      await pair(db, a, p, v, -30n, { sub_account: 'frozen', account_version: 3n });
      await pair(db, a, p, v, 10n, {
        sub_account: 'frozen',
        ledger_type: 'CLAWBACK',
        account_version: 4n,
      });
      await pair(
        db,
        a,
        p,
        await voucher(db, { app_id: APP, accounting_date: '2032-06-14' }),
        -1000n,
      );
      await pair(
        db,
        a,
        p,
        await voucher(db, { app_id: APP, accounting_date: '2032-06-16' }),
        -800n,
      );
      const before = await immutableState(db);
      const result = await runner.runDailyCheck(db, { accountingDate: DAY });
      expect(result.accountingDate).toBe(DAY);
      const rows = (await snapshots(db)).filter((r) => r.day === DAY);
      expect(rows).toHaveLength(3);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            account_id: a.id,
            sub_account: 'available',
            opening_fen: -1000n,
            debit_fen: 70n,
            credit_fen: 200n,
            closing_fen: -1130n,
          }),
          expect.objectContaining({
            account_id: a.id,
            sub_account: 'frozen',
            opening_fen: -50n,
            debit_fen: 10n,
            credit_fen: 30n,
            closing_fen: -70n,
          }),
          expect.objectContaining({
            account_id: p.id,
            sub_account: 'available',
            opening_fen: 1000n,
            debit_fen: 230n,
            credit_fen: 80n,
            closing_fen: 1150n,
          }),
        ]),
      );
      expect(rows.map((r) => r.computed_at.toISOString())).toEqual([NOW, NOW, NOW]);
      expect(await immutableState(db)).toEqual(before);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02j#16] 中间漏跑一天时，期初取截至前日的全部分录合计，不沿用隔日快照或归零',
  async () => {
    const { runner } = setup();
    await inDatabase(createTestDatabase, async (db) => {
      const a = await account(db, { app_id: APP });
      const inactive = await account(db, { app_id: APP });
      const p = await platform(db, 'UNION_RECEIVABLE:taobao', APP);
      await pair(
        db,
        a,
        p,
        await voucher(db, { app_id: APP, accounting_date: '2032-06-13' }),
        -100n,
      );
      // Only older entries: neither the missed day nor the checked day has activity.
      await pair(
        db,
        inactive,
        p,
        await voucher(db, { app_id: APP, accounting_date: '2032-06-13' }),
        -60n,
      );
      await runner.runDailyCheck(db, { accountingDate: '2032-06-13' });
      await pair(
        db,
        a,
        p,
        await voucher(db, { app_id: APP, accounting_date: '2032-06-14' }),
        -40n,
        { account_version: 2n },
      );
      await pair(db, a, p, await voucher(db, { app_id: APP, accounting_date: '2032-06-14' }), 15n, {
        ledger_type: 'CLAWBACK',
        account_version: 3n,
      });
      await pair(db, a, p, await voucher(db, { app_id: APP }), -20n, {
        account_version: 4n,
      });
      const before = await snapshots(db);
      expect(before).toHaveLength(3);
      expect(before.every((r) => r.day === '2032-06-13')).toBe(true);
      await runner.runDailyCheck(db, { accountingDate: DAY });
      const rows = await snapshots(db);
      expect(rows.filter((r) => r.day === '2032-06-13')).toEqual(before);
      expect(rows.filter((r) => r.day === DAY)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            account_id: a.id,
            sub_account: 'available',
            opening_fen: -125n,
            debit_fen: 0n,
            credit_fen: 20n,
            closing_fen: -145n,
          }),
          expect.objectContaining({
            account_id: p.id,
            sub_account: 'available',
            opening_fen: 185n,
            debit_fen: 20n,
            credit_fen: 0n,
            closing_fen: 205n,
          }),
          expect.objectContaining({
            account_id: inactive.id,
            sub_account: 'available',
            opening_fen: -60n,
            debit_fen: 0n,
            credit_fen: 0n,
            closing_fen: -60n,
          }),
        ]),
      );
      expect(rows.filter((r) => r.day === DAY)).toHaveLength(3);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02j#2] 连续多日承接上日期末，无新分录仍结转，未活动子户不臆造快照',
  async () => {
    const { runner, clock } = setup();
    await inDatabase(createTestDatabase, async (db) => {
      const a = await account(db, { app_id: APP });
      const idle = await account(db, { app_id: APP });
      const p = await platform(db, 'UNION_RECEIVABLE:taobao', APP);
      await pair(
        db,
        a,
        p,
        await voucher(db, { app_id: APP, accounting_date: '2032-02-28' }),
        -120n,
      );
      await balance(db, a, 120n);
      for (const day of ['2032-02-28', '2032-02-29', '2032-03-01']) {
        await runner.runDailyCheck(db, { accountingDate: day });
        clock.advanceMs(86_400_000);
      }
      const rows = await snapshots(db);
      expect(rows).toHaveLength(6);
      expect(rows.filter((r) => r.account_id === idle.id)).toEqual([]);
      expect(
        rows
          .filter((r) => r.account_id === a.id)
          .map((r) => ({
            day: r.day,
            sub: r.sub_account,
            opening: r.opening_fen,
            debit: r.debit_fen,
            credit: r.credit_fen,
            closing: r.closing_fen,
          })),
      ).toEqual([
        {
          day: '2032-02-28',
          sub: 'available',
          opening: 0n,
          debit: 0n,
          credit: 120n,
          closing: -120n,
        },
        {
          day: '2032-02-29',
          sub: 'available',
          opening: -120n,
          debit: 0n,
          credit: 0n,
          closing: -120n,
        },
        {
          day: '2032-03-01',
          sub: 'available',
          opening: -120n,
          debit: 0n,
          credit: 0n,
          closing: -120n,
        },
      ]);
      expect(rows.filter((r) => r.account_id === p.id).map((r) => r.closing_fen)).toEqual([
        120n,
        120n,
        120n,
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02j#3] 同日重跑覆盖坏快照和迟到分录，不重复累计；computed_at 使用本次 Clock',
  async () => {
    const { runner, clock } = setup();
    await inDatabase(createTestDatabase, async (db) => {
      const a = await account(db, { app_id: APP });
      const p = await platform(db, 'UNION_RECEIVABLE:taobao', APP);
      await pair(db, a, p, await voucher(db, { app_id: APP }), -100n);
      await daily(db, a, { opening_fen: 800n, debit_fen: 9n, credit_fen: 1n, closing_fen: 808n });
      await runner.runDailyCheck(db, { accountingDate: DAY });
      const first = await snapshots(db);
      expect(first.filter((r) => r.account_id === a.id)).toEqual([
        expect.objectContaining({
          opening_fen: 0n,
          debit_fen: 0n,
          credit_fen: 100n,
          closing_fen: -100n,
        }),
      ]);
      await runner.runDailyCheck(db, { accountingDate: DAY });
      expect(await snapshots(db)).toEqual(first);
      await pair(db, a, p, await voucher(db, { app_id: APP }), -40n, { account_version: 2n });
      clock.set('2032-06-16T18:03:04.000Z');
      await runner.runDailyCheck(db, { accountingDate: DAY });
      const second = await snapshots(db);
      expect(second).toHaveLength(2);
      expect(second.filter((r) => r.account_id === a.id)).toEqual([
        expect.objectContaining({
          day: DAY,
          opening_fen: 0n,
          debit_fen: 0n,
          credit_fen: 140n,
          closing_fen: -140n,
        }),
      ]);
      expect(second.map((r) => r.computed_at.toISOString())).toEqual([
        '2032-06-16T18:03:04.000Z',
        '2032-06-16T18:03:04.000Z',
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02j#4] 超过 JS 安全整数的一分钱差额仍精确保存',
  async () => {
    const { runner } = setup();
    await inDatabase(createTestDatabase, async (db) => {
      const a = await account(db, { app_id: APP });
      const v = await voucher(db, { app_id: APP });
      await entry(db, a, v, -9007199254740993n);
      await entry(db, a, v, 1n, { ledger_type: 'CLAWBACK', account_version: 2n });
      await runner.runDailyCheck(db, { accountingDate: DAY });
      expect(await snapshots(db)).toEqual([
        expect.objectContaining({
          opening_fen: 0n,
          debit_fen: 1n,
          credit_fen: 9007199254740993n,
          closing_fen: -9007199254740992n,
        }),
      ]);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02j#5] appId 限定快照写入范围，未指定时处理所有应用',
  async () => {
    const { runner } = setup();
    await inDatabase(createTestDatabase, async (db) => {
      const a = await account(db, { app_id: APP });
      const b = await account(db, { app_id: OTHER, owner_id: a.owner_id });
      await entry(db, a, await voucher(db, { app_id: APP, uniq_key: 'same-key' }), -70n);
      await entry(db, b, await voucher(db, { app_id: OTHER, uniq_key: 'same-key' }), -90n);
      await daily(db, b, { closing_fen: -777n, credit_fen: 777n });
      const untouched = await snapshots(db, OTHER);
      await runner.runDailyCheck(db, { appId: APP, accountingDate: DAY });
      expect(await snapshots(db)).toEqual([expect.objectContaining({ closing_fen: -70n })]);
      expect(await snapshots(db, OTHER)).toEqual(untouched);
      await runner.runDailyCheck(db, { accountingDate: DAY });
      expect(await snapshots(db, OTHER)).toEqual([expect.objectContaining({ closing_fen: -90n })]);
    });
  },
  TIMEOUT,
);
