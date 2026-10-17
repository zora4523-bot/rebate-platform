import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import {
  APP,
  OTHER_APP,
  TIMEOUT,
  account,
  clean,
  detailContains,
  differences,
  entry,
  platform,
  scenario,
  voucher,
} from './kit.ts';

it(
  '[AC-B2-02e#17] ⑦ 三种允许类型与键中含 REASSIGN_REV 的红冲可下降至负数',
  async () => {
    await scenario(createTestDatabase, '07', async ({ db, check }) => {
      for (const ledgerType of ['CLAWBACK', 'SETTLE_ADJUST', 'ADMIN_ADJUST']) {
        const a = await account(db);
        await entry(db, a, await voucher(db), -50n, { balance_after_fen: 50n });
        await entry(db, a, await voucher(db), 100n, {
          ledger_type: ledgerType,
          balance_after_fen: -50n,
          account_version: 2n,
        });
      }
      for (const ledgerType of ['REBATE_CREDIT', 'SHARE_CREDIT', 'REFERRAL_CREDIT']) {
        const a = await account(db);
        await entry(db, a, await voucher(db), -50n, { balance_after_fen: 50n });
        // Structured kind alone is not the R14 exception: the original rule names uniq_key.
        const v = await voucher(db, {
          voucher_kind: 'CREDIT',
          uniq_key: `taobao:one:${a.owner_id}:self:REASSIGN_REV:event`,
        });
        await entry(db, a, v, 100n, {
          ledger_type: ledgerType,
          balance_after_fen: -50n,
          account_version: 2n,
        });
      }
      clean(await check());
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#18] ⑦ 账户版本决定先后，仍为负但回升、持平、降到零均不误报',
  async () => {
    await scenario(createTestDatabase, '07', async ({ db, check }) => {
      const a = await account(db);
      // Insert and booked_at order deliberately disagree with account_version order.
      await entry(db, a, await voucher(db), -50n, {
        ledger_type: 'REBATE_CREDIT',
        balance_after_fen: -50n,
        account_version: 2n,
        booked_at: '2032-06-14T00:00:00Z',
      });
      await entry(db, a, await voucher(db), 100n, {
        ledger_type: 'CLAWBACK',
        balance_after_fen: -100n,
        account_version: 1n,
        booked_at: '2032-06-16T00:00:00Z',
      });
      // Corrupt amount is irrelevant to ⑦: it checks the two recorded balance_after values.
      await entry(db, a, await voucher(db), 1n, {
        ledger_type: 'WITHDRAW_FEE',
        balance_after_fen: -50n,
        account_version: 3n,
      });
      const first = await check();
      clean(first);
      const b = await account(db);
      await entry(db, b, await voucher(db), -20n, { balance_after_fen: 20n });
      await entry(db, b, await voucher(db), 20n, {
        ledger_type: 'WITHDRAW_FEE',
        balance_after_fen: 0n,
        account_version: 2n,
      });
      const second = await check();
      clean(second);
      expect(second[0]!.checked_rows).toBeGreaterThan(first[0]!.checked_rows);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#19] ⑦ 普通扣费与普通 REVERSE 导致负余额下降时逐条报账户差异',
  async () => {
    await scenario(createTestDatabase, '07', async ({ db, check }) => {
      const a = await account(db);
      const start = await voucher(db);
      const fee = await voucher(db);
      const reverse = await voucher(db, { uniq_key: 'taobao:one:ordinary:REVERSE' });
      await entry(db, a, start, -10n, { balance_after_fen: 10n });
      await entry(db, a, fee, 11n, {
        ledger_type: 'WITHDRAW_FEE',
        balance_after_fen: -1n,
        account_version: 2n,
      });
      await entry(db, a, reverse, 1n, {
        ledger_type: 'REBATE_CREDIT',
        balance_after_fen: -2n,
        account_version: 3n,
      });
      const rows = await check();
      differences(rows, 'account');
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.account_id === a.id && r.app_id === APP)).toBe(true);
      detailContains(rows, 10n, -1n, -2n);
      for (const v of [fee, reverse]) {
        expect(JSON.stringify(rows.map((r) => r.detail))).toMatch(
          new RegExp(`${v.id}|${v.uniq_key}`),
        );
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#20] ⑦ 首笔负余额不能漏检，假冒 sub_type 或 voucher_kind 不能冒充红冲键',
  async () => {
    await scenario(createTestDatabase, '07', async ({ db, check }) => {
      const ids: string[] = [];
      for (const uniqKey of ['ordinary', 'ordinary:REVERSE', 'ordinary:NOT_REASSIGN_REV:event']) {
        const a = await account(db, { app_id: OTHER_APP });
        ids.push(a.id);
        const v = await voucher(db, {
          app_id: OTHER_APP,
          uniq_key: uniqKey,
          voucher_kind: 'REASSIGN_REV',
        });
        await entry(db, a, v, 1n, { sub_type: 'REASSIGN_REV', balance_after_fen: -1n });
      }
      const rows = await check();
      differences(rows, 'account');
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.account_id).sort()).toEqual(ids.sort());
      expect(rows.every((r) => r.app_id === OTHER_APP)).toBe(true);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#21] ⑦ 不跨账户、app 或子户比较余额，平台负数不当作用户差异',
  async () => {
    await scenario(createTestDatabase, '07', async ({ db, check }) => {
      const a = await account(db);
      const b = await account(db, { app_id: OTHER_APP, owner_id: a.owner_id });
      await entry(db, a, await voucher(db), 100n, {
        ledger_type: 'CLAWBACK',
        balance_after_fen: -100n,
      });
      await entry(db, a, await voucher(db), -20n, {
        sub_account: 'frozen',
        balance_after_fen: 20n,
        account_version: 2n,
      });
      await entry(db, a, await voucher(db), -50n, { balance_after_fen: -50n, account_version: 3n });
      await entry(db, b, await voucher(db, { app_id: OTHER_APP }), 500n, {
        ledger_type: 'CLAWBACK',
        balance_after_fen: -500n,
      });
      const p = await platform(db);
      await entry(db, p, await voucher(db), 100n, {
        ledger_type: 'WITHDRAW_FEE',
        balance_after_fen: -100n,
        account_version: 1n,
      });
      clean(await check());
    });
  },
  TIMEOUT,
);
