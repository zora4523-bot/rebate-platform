import { randomUUID } from 'node:crypto';

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
  pair,
  platform,
  scenario,
  voucher,
} from './kit.ts';

it(
  '[AC-B2-02e#11] ④ 部分扣回、全额扣回、RESTORE 后再次扣回净额为零应通过',
  async () => {
    await scenario(createTestDatabase, '04', async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const key = {
        order_key: 'taobao:restore-cycle',
        beneficiary_user_id: a.owner_id,
        role: 'self',
      };
      // Explicit expected business history: +400 -120 -280 +400 -400 = 0.
      for (const [kind, type, amount, subType] of [
        ['CREDIT', 'REBATE_CREDIT', -400n, null],
        ['CLAWBACK', 'CLAWBACK', 120n, null],
        ['CLAWBACK', 'CLAWBACK', 280n, null],
        ['ADMIN_ADJUST', 'ADMIN_ADJUST', -400n, 'RESTORE'],
        ['CLAWBACK', 'CLAWBACK', 400n, null],
      ] as const) {
        const v = await voucher(db, { ...key, voucher_kind: kind });
        await pair(db, a, p, v, amount, { ledger_type: type, sub_type: subType });
      }
      // Other admin adjustments / unrelated rewards do not change this order's beneficiary net.
      await pair(db, a, p, await voucher(db, { ...key, voucher_kind: 'ADMIN_ADJUST' }), 5n, {
        ledger_type: 'ADMIN_ADJUST',
        sub_type: 'RECON_FIX',
      });
      await pair(db, a, p, await voucher(db, { ...key, voucher_kind: 'REWARD' }), 5n, {
        ledger_type: 'REWARD',
      });
      clean(await check());
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#12] ④ 正负 SETTLE_ADJUST 按代数和计算，一分过扣报受益人键和实际净额',
  async () => {
    await scenario(createTestDatabase, '04', async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const key = { order_key: 'taobao:adjust', beneficiary_user_id: a.owner_id, role: 'self' };
      for (const [kind, type, amount] of [
        ['CREDIT', 'REBATE_CREDIT', -100n],
        ['SETTLE_ADJUST', 'SETTLE_ADJUST', -50n],
        ['SETTLE_ADJUST', 'SETTLE_ADJUST', 20n],
        ['CLAWBACK', 'CLAWBACK', 130n],
      ] as const) {
        await pair(db, a, p, await voucher(db, { ...key, voucher_kind: kind }), amount, {
          ledger_type: type,
        });
      }
      clean(await check());
      await pair(db, a, p, await voucher(db, { ...key, voucher_kind: 'CLAWBACK' }), 1n, {
        ledger_type: 'CLAWBACK',
      });
      const rows = await check();
      differences(rows, 'global');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.app_id).toBe(APP);
      detailContains(rows, key.order_key, a.owner_id, 'self', -1n, 0n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#13] ④ 其他订单、受益人、角色与应用的正净额不能抵消本键负净额',
  async () => {
    await scenario(createTestDatabase, '04', async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const key = { order_key: 'taobao:isolated', beneficiary_user_id: a.owner_id, role: 'self' };
      await pair(db, a, p, await voucher(db, { ...key, voucher_kind: 'CREDIT' }), -100n);
      await pair(db, a, p, await voucher(db, { ...key, voucher_kind: 'CLAWBACK' }), 101n, {
        ledger_type: 'CLAWBACK',
      });
      const first = await check();
      differences(first, 'global');
      const other = await account(db);
      const otherApp = await account(db, { app_id: OTHER_APP, owner_id: a.owner_id });
      const otherPlatform = await platform(db, 'UNION_RECEIVABLE:taobao', OTHER_APP);
      for (const [recipient, counter, fields] of [
        [a, p, { order_key: 'jd:isolated' }],
        [a, p, { role: 'direct' }],
        [other, p, { beneficiary_user_id: other.owner_id }],
        [otherApp, otherPlatform, { app_id: OTHER_APP }],
      ] as const) {
        await pair(
          db,
          recipient,
          counter,
          await voucher(db, { ...key, voucher_kind: 'CREDIT', ...fields }),
          -200n,
        );
      }
      const rows = await check();
      differences(rows, 'global');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.app_id).toBe(APP);
      expect(rows[0]!.checked_rows).toBeGreaterThan(first[0]!.checked_rows);
      detailContains(rows, key.order_key, a.owner_id, 'self', -1n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#14] ④ 转平台坏账的扣回仍消耗受益人净额，归平台正差不能掩盖过扣',
  async () => {
    await scenario(createTestDatabase, '04', async ({ db, check }) => {
      const a = await account(db);
      const receivable = await platform(db);
      const debt = await platform(db, 'BAD_DEBT');
      const revenue = await platform(db, 'COMMISSION_REVENUE');
      const key = { order_key: 'taobao:bad-debt', beneficiary_user_id: a.owner_id, role: 'self' };
      await pair(db, a, receivable, await voucher(db, { ...key, voucher_kind: 'CREDIT' }), -100n);
      await pair(
        db,
        debt,
        receivable,
        await voucher(db, { ...key, voucher_kind: 'CLAWBACK' }),
        100n,
        { ledger_type: 'CLAWBACK' },
      );
      clean(await check());
      await pair(
        db,
        debt,
        receivable,
        await voucher(db, { ...key, voucher_kind: 'CLAWBACK' }),
        1n,
        { ledger_type: 'CLAWBACK' },
      );
      // Same structured beneficiary key, but the positive adjustment is paid to the platform.
      await pair(
        db,
        revenue,
        receivable,
        await voucher(db, { ...key, voucher_kind: 'SETTLE_ADJUST' }),
        -500n,
        { ledger_type: 'SETTLE_ADJUST' },
      );
      const rows = await check();
      differences(rows, 'global');
      expect(rows).toHaveLength(1);
      detailContains(rows, key.order_key, a.owner_id, -1n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#15] ④ 改派红冲与新受益人改派入账都计入，红冲沿用入账流水类型',
  async () => {
    await scenario(createTestDatabase, '04', async ({ db, check }) => {
      const oldUser = await account(db);
      const newUser = await account(db);
      const p = await platform(db);
      const key = { order_key: 'taobao:reassign', role: 'self' };
      const oldKey = { ...key, beneficiary_user_id: oldUser.owner_id };
      const newKey = { ...key, beneficiary_user_id: newUser.owner_id };
      const reassignId = randomUUID();
      // D3 A: ④ uses voucher_kind; both keys also follow the BR-FUND-16 / BR-FUND-10 format.
      await pair(db, oldUser, p, await voucher(db, { ...oldKey, voucher_kind: 'CREDIT' }), -400n);
      await pair(
        db,
        oldUser,
        p,
        await voucher(db, {
          ...oldKey,
          voucher_kind: 'REASSIGN_REV',
          uniq_key: `${key.order_key}:${oldUser.owner_id}:self:REASSIGN_REV:${reassignId}`,
        }),
        400n,
      );
      await pair(
        db,
        newUser,
        p,
        await voucher(db, {
          ...newKey,
          voucher_kind: 'REASSIGN_CREDIT',
          uniq_key: `${key.order_key}:${newUser.owner_id}:self:REASSIGN_CREDIT:${reassignId}`,
        }),
        -400n,
      );
      await pair(db, newUser, p, await voucher(db, { ...newKey, voucher_kind: 'CLAWBACK' }), 400n, {
        ledger_type: 'CLAWBACK',
      });
      clean(await check());
      await pair(db, oldUser, p, await voucher(db, { ...oldKey, voucher_kind: 'CLAWBACK' }), 1n, {
        ledger_type: 'CLAWBACK',
      });
      const rows = await check();
      differences(rows, 'global');
      expect(rows).toHaveLength(1);
      detailContains(rows, oldUser.owner_id, key.order_key, -1n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#23] ④ 跨日入账与扣回按全量净额校验，部分及全额扣回通过、多扣一分报差异',
  async () => {
    await scenario(createTestDatabase, '04', async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const key = { order_key: 'taobao:cross-day', beneficiary_user_id: a.owner_id, role: 'self' };
      await pair(
        db,
        a,
        p,
        await voucher(db, { ...key, voucher_kind: 'CREDIT', accounting_date: '2032-06-14' }),
        -400n,
        { booked_at: '2032-06-14T08:00:00Z', balance_after_fen: 400n },
      );
      await pair(
        db,
        a,
        p,
        await voucher(db, { ...key, voucher_kind: 'CLAWBACK', accounting_date: '2032-06-15' }),
        120n,
        { ledger_type: 'CLAWBACK', account_version: 2n, balance_after_fen: 280n },
      );
      clean(await check('2032-06-15'));
      await pair(
        db,
        a,
        p,
        await voucher(db, { ...key, voucher_kind: 'CLAWBACK', accounting_date: '2032-06-15' }),
        280n,
        { ledger_type: 'CLAWBACK', account_version: 3n, balance_after_fen: 0n },
      );
      clean(await check('2032-06-15'));
      await pair(
        db,
        a,
        p,
        await voucher(db, { ...key, voucher_kind: 'CLAWBACK', accounting_date: '2032-06-15' }),
        1n,
        { ledger_type: 'CLAWBACK', account_version: 4n, balance_after_fen: -1n },
      );
      // An all-history check must also find the over-clawback on a day with no new vouchers.
      for (const date of ['2032-06-15', '2032-06-16']) {
        const rows = await check(date);
        differences(rows, 'global');
        expect(rows).toHaveLength(1);
        expect(rows[0]!.app_id).toBe(APP);
        detailContains(rows, key.order_key, a.owner_id, 'self', -1n, 0n);
      }
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#16] ④ 超过 2^53 的 CREDIT 与扣回只差一分仍报负净额',
  async () => {
    await scenario(createTestDatabase, '04', async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const key = { order_key: 'taobao:large', beneficiary_user_id: a.owner_id, role: 'self' };
      await pair(
        db,
        a,
        p,
        await voucher(db, { ...key, voucher_kind: 'CREDIT' }),
        -9007199254740992n,
      );
      await pair(
        db,
        a,
        p,
        await voucher(db, { ...key, voucher_kind: 'CLAWBACK' }),
        9007199254740993n,
        { ledger_type: 'CLAWBACK' },
      );
      const rows = await check();
      differences(rows, 'global');
      expect(rows).toHaveLength(1);
      detailContains(rows, key.order_key, a.owner_id, -1n);
    });
  },
  TIMEOUT,
);
