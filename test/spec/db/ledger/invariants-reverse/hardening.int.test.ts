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
  voucher,
} from '../invariants/kit.ts';
import { scenario } from './kit.ts';

it(
  '[AC-B2-02m#1] B2-02l#8 同形数据只检查五个 CREDIT 键，与旧 03 的 checked_rows 相等',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      // Keep the construction identical to B2-02l#8, including the middle REVERSE token.
      const key = {
        order_key: 'taobao:grouping',
        beneficiary_user_id: randomUUID(),
        role: 'self',
        voucher_kind: 'CREDIT',
      };
      await voucher(db, { ...key, uniq_key: 'same:REVERSE:middle' });
      for (const fields of [
        { app_id: OTHER_APP, uniq_key: 'same:REVERSE:middle' },
        { order_key: 'jd:grouping' },
        { beneficiary_user_id: randomUUID() },
        { role: 'direct' },
        { voucher_kind: 'SETTLE_ADJUST' },
      ])
        await voucher(db, { ...key, ...fields });

      const rows = await check('03');
      const legacy = await check('03', true);
      clean(rows);
      clean(legacy);
      // Base + other app + other order + other beneficiary + other role = 5.
      // SETTLE_ADJUST contributes no CREDIT key.
      expect(rows[0]!.checked_rows).toBe(5n);
      expect(legacy[0]!.checked_rows).toBe(5n);
      expect(rows[0]!.checked_rows).toBe(legacy[0]!.checked_rows);

      await voucher(db, { ...key, uniq_key: 'another' });
      const duplicate = await check('03');
      const legacyDuplicate = await check('03', true);
      for (const result of [duplicate, legacyDuplicate]) {
        differences(result, 'global');
        expect(result).toHaveLength(1);
        expect(result[0]!.app_id).toBe(APP);
        expect(result[0]!.checked_rows).toBe(5n);
        detailContains(result, key.order_key, key.beneficiary_user_id, 'self');
      }
      expect(duplicate[0]!.checked_rows).toBe(legacyDuplicate[0]!.checked_rows);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02m#2] 原 CREDIT 入账 100、仅红冲 99 后重记 50，必须报一行全局差异',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const key = {
        order_key: 'taobao:short-reversal',
        beneficiary_user_id: a.owner_id,
        role: 'self',
        voucher_kind: 'CREDIT',
      };
      for (const [uniq_key, amount] of [
        ['A', -100n],
        ['A:REVERSE', 99n],
        ['B', -50n],
      ] as const) {
        // Every voucher balances; only the original/reversal pair is one fen short.
        await pair(db, a, p, await voucher(db, { ...key, uniq_key }), amount);
      }
      const rows = await check('03');
      differences(rows, 'global');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ app_id: APP, checked_rows: 1n });
      detailContains(rows, key.order_key, a.owner_id, 'self', 'A', 'A:REVERSE', 'B');
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02m#3] 对照：原 CREDIT 入账 100、足额红冲 100 后重记 50，不报差异',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const key = {
        order_key: 'taobao:short-reversal',
        beneficiary_user_id: a.owner_id,
        role: 'self',
        voucher_kind: 'CREDIT',
      };
      for (const [uniq_key, amount] of [
        ['A', -100n],
        ['A:REVERSE', 100n],
        ['B', -50n],
      ] as const) {
        await pair(db, a, p, await voucher(db, { ...key, uniq_key }), amount);
      }
      const rows = await check('03');
      clean(rows);
      expect(rows[0]!.checked_rows).toBe(1n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02m#4] 红冲多出原单没有的 frozen 分录项，即使额外项净额为零也须报差异',
  async () => {
    await scenario(createTestDatabase, async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const key = {
        order_key: 'taobao:extra-reversal-item',
        beneficiary_user_id: a.owner_id,
        role: 'self',
        voucher_kind: 'CREDIT',
      };
      await pair(db, a, p, await voucher(db, { ...key, uniq_key: 'A' }), -100n);
      const reversal = await voucher(db, { ...key, uniq_key: 'A:REVERSE' });
      await pair(db, a, p, reversal, 100n);
      // Balanced extra pairs cancel each other, so checking just residual amounts misses this.
      // The platform counter-entries retain the required available sub-account.
      await pair(db, a, p, reversal, 1n, { sub_account: 'frozen', account_version: 2n });
      await pair(db, a, p, reversal, -1n, { sub_account: 'frozen', account_version: 3n });
      await pair(db, a, p, await voucher(db, { ...key, uniq_key: 'B' }), -50n);

      const rows = await check('03');
      differences(rows, 'global');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ app_id: APP, checked_rows: 1n });
      detailContains(rows, key.order_key, a.owner_id, 'self', 'A', 'A:REVERSE', 'B');
    });
  },
  TIMEOUT,
);
