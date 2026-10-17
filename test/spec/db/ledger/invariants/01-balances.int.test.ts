import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import {
  APP,
  OTHER_APP,
  TIMEOUT,
  account,
  balance,
  clean,
  daily,
  detailContains,
  differences,
  entry,
  platform,
  scenario,
  voucher,
} from './kit.ts';

it(
  '[AC-B2-02e#1] ① 用户负债余额按分录反号分子户核对，正常账户与无发生账户通过',
  async () => {
    await scenario(createTestDatabase, '01', async ({ db, check }) => {
      const a = await account(db);
      const v = await voucher(db, { accounting_date: '2032-06-14' });
      await entry(db, a, v, -100n);
      await entry(db, a, v, -20n, { sub_account: 'frozen', account_version: 2n });
      await balance(db, a, 100n, 20n);
      // Daily balances use the signed debit/credit convention of migration 0038.
      await daily(db, a, { opening_fen: -100n, closing_fen: -100n });
      await daily(db, a, { sub_account: 'frozen', opening_fen: -20n, closing_fen: -20n });
      const first = await check();
      clean(first);
      const idle = await account(db, { app_id: OTHER_APP, owner_id: a.owner_id });
      await balance(db, idle, 0n);
      await daily(db, idle);
      await daily(db, idle, { sub_account: 'frozen' });
      const second = await check();
      clean(second);
      expect(second[0]!.checked_rows).toBeGreaterThan(first[0]!.checked_rows);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#22] ① 非零借贷发生额进入期末等式，冻结子户日余额也必须校验',
  async () => {
    await scenario(createTestDatabase, '01', async ({ db, check }) => {
      const a = await account(db);
      const prior = await voucher(db, { accounting_date: '2032-06-14' });
      const today = await voucher(db);
      await entry(db, a, prior, -100n);
      await entry(db, a, today, 10n, { account_version: 2n });
      await entry(db, a, today, -50n, { account_version: 3n });
      await entry(db, a, today, -30n, { sub_account: 'frozen', account_version: 4n });
      await balance(db, a, 140n, 30n);
      await daily(db, a, {
        opening_fen: -100n,
        debit_fen: 10n,
        credit_fen: 50n,
        closing_fen: -140n,
      });
      await daily(db, a, { sub_account: 'frozen', credit_fen: 30n, closing_fen: -30n });
      clean(await check());
      // A different selected day has a bad frozen closing, with a correct available row.
      await daily(db, a, { accounting_date: '2032-06-16', opening_fen: -140n, closing_fen: -140n });
      await daily(db, a, {
        accounting_date: '2032-06-16',
        sub_account: 'frozen',
        opening_fen: -30n,
        closing_fen: -29n,
      });
      const rows = await check('2032-06-16');
      differences(rows, 'account');
      expect(rows.every((r) => r.account_id === a.id && r.app_id === APP)).toBe(true);
      detailContains(rows, 'frozen', -30n, -29n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#2] ① available 与 frozen 错位即使总额正确也报出两个应用各自的账户',
  async () => {
    await scenario(createTestDatabase, '01', async ({ db, check }) => {
      const ids: string[] = [];
      for (const appId of [APP, OTHER_APP]) {
        const a = await account(db, { app_id: appId });
        ids.push(a.id);
        const v = await voucher(db, { app_id: appId, accounting_date: '2032-06-14' });
        await entry(db, a, v, -100n);
        await entry(db, a, v, -20n, { sub_account: 'frozen', account_version: 2n });
        await balance(db, a, 90n, 30n);
        await daily(db, a, { opening_fen: -100n, closing_fen: -100n });
        await daily(db, a, { sub_account: 'frozen', opening_fen: -20n, closing_fen: -20n });
      }
      const rows = await check();
      differences(rows, 'account');
      expect([...new Set(rows.map((r) => r.account_id))].sort()).toEqual(ids.sort());
      expect([...new Set(rows.map((r) => r.app_id))].sort()).toEqual([APP, OTHER_APP]);
      detailContains(rows, 100n, 90n, 20n, 30n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#3] ① 会计日参数只选择当天日余额，期初加借减贷不等期末须报差异',
  async () => {
    await scenario(createTestDatabase, '01', async ({ db, check }) => {
      const a = await account(db);
      const before = await voucher(db, { accounting_date: '2032-06-14' });
      await entry(db, a, before, -100n);
      const today = await voucher(db);
      await entry(db, a, today, 40n, { account_version: 2n });
      await entry(db, a, today, -40n, { account_version: 3n });
      await balance(db, a, 100n);
      await daily(db, a, {
        opening_fen: -100n,
        debit_fen: 40n,
        credit_fen: 40n,
        closing_fen: -99n,
      });
      await daily(db, a, { sub_account: 'frozen' });
      await daily(db, a, { accounting_date: '2032-06-16', opening_fen: -100n, closing_fen: -100n });
      await daily(db, a, { accounting_date: '2032-06-16', sub_account: 'frozen' });
      clean(await check('2032-06-16'));
      const rows = await check('2032-06-15');
      differences(rows, 'account');
      expect(rows.every((r) => r.account_id === a.id && r.app_id === a.app_id)).toBe(true);
      detailContains(rows, -100n, -99n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#4] ① 超过 2^53 的余额相差一分仍被识别，平台账户不参与用户缓存核对',
  async () => {
    await scenario(createTestDatabase, '01', async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const v = await voucher(db, { accounting_date: '2032-06-14' });
      await entry(db, a, v, -9007199254740993n);
      await entry(db, p, v, 9007199254740993n);
      await balance(db, a, 9007199254740992n);
      await daily(db, a, { opening_fen: -9007199254740993n, closing_fen: -9007199254740993n });
      await daily(db, a, { sub_account: 'frozen' });
      const rows = await check();
      differences(rows, 'account');
      expect(rows.every((r) => r.account_id === a.id)).toBe(true);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#5] ① 有分录但遗漏缓存的用户不能被内连接静默丢弃',
  async () => {
    await scenario(createTestDatabase, '01', async ({ db, check }) => {
      const a = await account(db);
      await entry(db, a, await voucher(db, { accounting_date: '2032-06-14' }), -100n);
      await daily(db, a, { opening_fen: -100n, closing_fen: -100n });
      await daily(db, a, { sub_account: 'frozen' });
      const rows = await check();
      differences(rows, 'account');
      expect(rows.some((r) => r.account_id === a.id && r.app_id === APP)).toBe(true);
    });
  },
  TIMEOUT,
);
