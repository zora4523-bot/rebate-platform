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
  entry,
  scenario,
  voucher,
} from './kit.ts';

it(
  '[AC-B2-02e#9] ③ 按结构化子订单、受益人、角色、app 归集，分录数量不是凭证数量',
  async () => {
    await scenario(createTestDatabase, '03', async ({ db, check }) => {
      const user = randomUUID();
      const key = {
        order_key: 'taobao:one',
        beneficiary_user_id: user,
        role: 'self',
        voucher_kind: 'CREDIT',
      };
      const v = await voucher(db, key);
      const a = await account(db, { owner_id: user });
      await entry(db, a, v, -80n);
      await entry(db, a, v, -20n, { sub_account: 'frozen', account_version: 2n });
      const first = await check();
      clean(first);
      for (const values of [
        { app_id: OTHER_APP },
        { order_key: 'jd:one' },
        { beneficiary_user_id: randomUUID() },
        { role: 'direct' },
      ])
        await voucher(db, { ...key, ...values });
      // Null structured metadata and unrelated voucher kinds are not CREDIT beneficiary keys.
      await voucher(db, { ...key, voucher_kind: 'SETTLE_ADJUST', uniq_key: 'misleading:CREDIT' });
      await voucher(db, { ...key, voucher_kind: 'REASSIGN_CREDIT' });
      await voucher(db, { voucher_kind: 'CREDIT' });
      await voucher(db, { voucher_kind: 'CREDIT' });
      const rows = await check();
      clean(rows);
      expect(rows[0]!.checked_rows).toBeGreaterThan(first[0]!.checked_rows);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#10] ③ uniq_key 不同但同受益人键出现两张 CREDIT 必须报全局差异',
  async () => {
    await scenario(createTestDatabase, '03', async ({ db, check }) => {
      const user = randomUUID();
      const key = {
        order_key: 'taobao:duplicate',
        beneficiary_user_id: user,
        role: 'self',
        voucher_kind: 'CREDIT',
      };
      await voucher(db, { ...key, uniq_key: 'opaque-a', accounting_date: '2031-01-01' });
      await voucher(db, { ...key, uniq_key: 'opaque-b' });
      await voucher(db, { ...key, app_id: OTHER_APP, uniq_key: 'opaque-a' });
      const rows = await check();
      differences(rows, 'global');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.app_id).toBe(APP);
      detailContains(rows, 'taobao:duplicate', user, 'self', 1n, 2n);
    });
  },
  TIMEOUT,
);
