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
  pair,
  platform,
  scenario,
  voucher,
} from './kit.ts';

it(
  '[AC-B2-02e#6] ② 多分录凭证各自守恒，检查行数随凭证数增加',
  async () => {
    await scenario(createTestDatabase, '02', async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const v = await voucher(db);
      await entry(db, a, v, -400n);
      await entry(db, a, v, -80n, { sub_account: 'frozen', account_version: 2n });
      await entry(db, p, v, 480n);
      const first = await check();
      clean(first);
      expect(first[0]!.checked_rows).toBe(1n);
      await pair(db, a, p, await voucher(db), -9007199254740993n);
      const second = await check();
      clean(second);
      expect(second[0]!.checked_rows).toBe(2n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#7] ② 相反方向的两张错误凭证不能互相抵消，返回各自凭证与差额',
  async () => {
    await scenario(createTestDatabase, '02', async ({ db, check }) => {
      const a = await account(db);
      const p = await platform(db);
      const positive = await voucher(db);
      const negative = await voucher(db);
      await entry(db, a, positive, -100n);
      await entry(db, p, positive, 101n);
      await entry(db, a, negative, -101n);
      await entry(db, p, negative, 100n);
      await pair(db, a, p, await voucher(db), -300n);
      const rows = await check();
      differences(rows, 'global');
      expect(rows).toHaveLength(2);
      expect(rows[0]!.checked_rows).toBe(3n);
      expect(rows.every((r) => r.app_id === APP)).toBe(true);
      // UUID or uniq_key are both acceptable voucher references.
      for (const v of [positive, negative]) {
        expect(JSON.stringify(rows.map((r) => r.detail))).toMatch(
          new RegExp(`${v.id}|${v.uniq_key}`),
        );
      }
      detailContains(rows, 0n, 1n, -1n);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-02e#8] ② 同 uniq_key 的不同应用凭证独立核对，大额一分差不能被舍入',
  async () => {
    await scenario(createTestDatabase, '02', async ({ db, check }) => {
      const good = await account(db);
      await pair(db, good, await platform(db), await voucher(db, { uniq_key: 'shared-key' }), -10n);
      const bad = await account(db, { app_id: OTHER_APP });
      const p = await platform(db, 'UNION_RECEIVABLE:taobao', OTHER_APP);
      const v = await voucher(db, {
        app_id: OTHER_APP,
        uniq_key: 'shared-key',
        accounting_date: '2031-01-01',
      });
      await entry(db, bad, v, -9007199254740993n);
      await entry(db, p, v, 9007199254740992n);
      const rows = await check();
      differences(rows, 'global');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.app_id).toBe(OTHER_APP);
      expect(rows[0]!.checked_rows).toBe(2n);
      detailContains(rows, 0n, -1n);
    });
  },
  TIMEOUT,
);
