import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { fixture } from '../bindings-pdd-query/kit.ts';
import { accountFixture, databaseFixture, listed, noSideEffects, TIMEOUT } from './kit.ts';

// 标准数据库入口由 createTestDatabase 读取 TEST_PG_ADMIN_URL。
const database = databaseFixture(createTestDatabase);

it.each(['pending_auth', 'invalid'] as const)(
  '[AC-B1-06zb#1] %s：备案查询使用绑定账号 A 的 self_buy 位，激活仍属于 A',
  async (status) => {
    const f = await accountFixture(database(), status);
    const result = await f.list();
    // 先观察实际查询身份，旧代码取 B 时应当在断言上红。
    expect(f.query.mock.calls.map(([identity]) => identity.claims.promotionSlot)).toEqual([
      f.slots.a.self_buy.pid,
    ]);
    expect(f.getActivePid).toHaveBeenCalledWith({
      appId: f.appId,
      platform: 'pdd',
      pidScene: 'self_buy',
      purpose: 'convert',
      unionAccountId: f.accountId,
    });
    expect(f.query.mock.calls[0]?.[0]).toMatchObject({
      custom_parameters: { app: 'n', uid: f.a.attr, sc: 'self_buy' },
    });
    await listed(result, 'active');
    expect(await f.bindings()).toEqual([
      expect.objectContaining({
        id: f.bindingId,
        status: 'active',
        union_account_id: f.accountId,
        row_version: 8,
      }),
    ]);
    await noSideEffects(f);
  },
  TIMEOUT,
);

it.each(['absent', 'unbound', 'released'] as const)(
  '[AC-B1-06zb#2] %s：无未释放绑定时，备案取位显式携带 self_buy 所选账号 B',
  async (status) => {
    const f = await accountFixture(database(), status);
    const before = await f.bindings();
    const result = await f.list();
    // authAccountId 可以无账号查询一次，但备案身份的查询必须带上其选出的 B。
    expect(f.getActivePid).toHaveBeenCalledWith({
      appId: f.appId,
      platform: 'pdd',
      pidScene: 'self_buy',
      purpose: 'convert',
      unionAccountId: f.slots.other.id,
    });
    expect(f.query.mock.calls.map(([identity]) => identity.claims.promotionSlot)).toEqual([
      f.slots.b.self_buy.pid,
    ]);
    await listed(result, 'active');
    const rows = await f.bindings();
    expect(rows.filter((row) => row.status === 'active')).toEqual([
      expect.objectContaining({ union_account_id: f.slots.other.id, user_id: f.a.userId }),
    ]);
    if (status === 'released') {
      expect(rows.find((row) => row.id === f.bindingId)).toEqual(before[0]);
    }
    await noSideEffects(f);
  },
  TIMEOUT,
);

it(
  '[AC-B1-06zb#3] 单账号刷新同样显式带账号，成功投影与激活行为保持不变',
  async () => {
    const f = await fixture(database(), 'invalid');
    const result = await f.list();
    expect(f.getActivePid).toHaveBeenCalledWith({
      appId: f.appId,
      platform: 'pdd',
      pidScene: 'self_buy',
      purpose: 'convert',
      unionAccountId: f.accountId,
    });
    await listed(result, 'active');
    expect(f.query).toHaveBeenCalledTimes(1);
    expect(await f.bindings()).toEqual([
      expect.objectContaining({ id: f.bindingId, status: 'active', union_account_id: f.accountId }),
    ]);
    await noSideEffects(f);
  },
  TIMEOUT,
);
