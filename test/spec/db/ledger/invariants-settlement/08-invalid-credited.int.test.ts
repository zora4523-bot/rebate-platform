import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  APP,
  OTHER_APP,
  TIMEOUT,
  clean,
  differences,
  identifies,
  order,
  person,
  rights,
  scenario,
} from './kit.ts';

it(
  '[AC-B2-04z#15] ⑧ INVALID仍CREDITED即报账户级差异，定位全部受益人且检查数按子订单',
  async () => {
    await scenario(createTestDatabase, '08', async ({ db, check }) => {
      const o = await order(db, { values: { platform_status: 'INVALID' } });
      const rows = await check(1n);
      differences(rows, 'account');
      identifies(rows, o);
      expect(new Set(rows.map((r) => r.account_id))).toEqual(
        new Set(o.people.map((p) => p.account.id)),
      );
      expect(rows).toHaveLength(2);
      expect(await check(1n, '2032-06-16')).toEqual(rows);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#16] ⑧ 平台仍SETTLED但存在成功INVALID_AFTER_SETTLE同样报，重复维权不倍增',
  async () => {
    await scenario(createTestDatabase, '08', async ({ db, check }) => {
      const o = await order(db);
      await rights(db, o);
      await rights(db, o);
      await rights(db, o, 'FAILED');
      const rows = await check(1n);
      differences(rows, 'account');
      identifies(rows, o);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.account_id))).toEqual(
        new Set(o.people.map((p) => p.account.id)),
      );
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#17] ⑧ 处理中、待佣金、失败及其他类型成功维权都不误报，不能用rights_pending替代',
  async () => {
    await scenario(createTestDatabase, '08', async ({ db, check }) => {
      const o = await order(db, { values: { rights_pending: true } });
      for (const status of ['PROCESSING', 'WAIT_COMMISSION', 'FAILED']) await rights(db, o, status);
      for (const type of ['RIGHTS', 'PUNISH', 'REFUND_AFTER_SETTLE'])
        await rights(db, o, 'SUCCEEDED', type);
      clean(await check(1n));
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#18] ⑧ INVALID与成功维权均存在时也不重复；同用户多角色只定位一个账户',
  async () => {
    await scenario(createTestDatabase, '08', async ({ db, check }) => {
      const p = await person(db, APP);
      const o = await order(db, {
        people: [p, { ...p, role: 'direct', ratio: 1000 }],
        values: { platform_status: 'INVALID' },
      });
      await rights(db, o);
      await rights(db, o);
      const rows = await check(1n);
      differences(rows, 'account');
      identifies(rows, o);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.account_id).toBe(p.account.id);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#19] ⑧ 失效或成功维权但已CLAWED_BACK、VOID等非CREDITED不误报也不计入候选数',
  async () => {
    await scenario(createTestDatabase, '08', async ({ db, check }) => {
      for (const rebate_status of ['CLAWED_BACK', 'VOID', 'WAITING', 'ESTIMATED', 'UNATTRIBUTED']) {
        const o = await order(db, { values: { platform_status: 'INVALID', rebate_status } });
        await rights(db, o);
      }
      await order(db); // 正常CREDITED仍被实际检查，不能以零差异充当零检查。
      clean(await check(1n));
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#20] ⑧ 另一应用另一平台的失效维权不会污染正常订单，差异保留正确app_id',
  async () => {
    await scenario(createTestDatabase, '08', async ({ db, check }) => {
      await order(db, { sub: 'same-sub' });
      const bad = await order(db, { app: OTHER_APP, platform: 'jd', sub: 'same-sub' });
      await rights(db, bad);
      const rows = await check(2n);
      differences(rows, 'account');
      identifies(rows, bad);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.app_id === OTHER_APP)).toBe(true);
      expect(new Set(rows.map((r) => r.account_id))).toEqual(
        new Set(bad.people.map((p) => p.account.id)),
      );
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04z#21] ⑧ 正常空集合返回零检查哨兵行',
  async () => {
    await scenario(createTestDatabase, '08', async ({ check }) => {
      clean(await check(0n));
    });
  },
  TIMEOUT,
);
