import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from './database.ts';
import { fixture, outcome, service } from './kit.ts';
import { identity, noConversion, response, success } from './assertions.ts';

const database = databaseFixture(createTestDatabase);

it('[AC-B1-06v#30] agent 快照按 agent 当前位查询与转链，不误用 self_buy 位', async () => {
  const f = await fixture(database(), { binding: 'absent', query: true, scene: 'agent' });
  const open = service(f);
  await success(await outcome(() => open.open(f.request())));
  expect(f.query).toHaveBeenCalledTimes(1);
  identity(f, f.query.mock.calls[0]![0], f.a.attr, 'agent');
  identity(f, f.convert.mock.calls[0]![1], f.a.attr, 'agent');
  expect(f.getActivePid).toHaveBeenCalledWith({
    appId: f.appId,
    platform: 'pdd',
    pidScene: 'agent',
    purpose: 'convert',
  });
  const rows = await f.bindings();
  expect(rows).toHaveLength(1);
  expect(JSON.parse(rows[0]!.pdd_custom!)).toEqual({ app: 'n', uid: f.a.attr, sc: 'agent' });
}, 60_000);

it('[AC-B1-06v#1] 本人 active 直接 200，不查询或重写绑定', async () => {
  const f = await fixture(database(), { binding: 'active', query: false });
  const before = await f.bindings();
  const open = service(f);
  await success(await outcome(() => open.open(f.request())));
  expect(f.query).not.toHaveBeenCalled();
  expect(await f.bindings()).toEqual(before);
  expect(await f.sessions()).toEqual([]);
  expect(f.convert).toHaveBeenCalledTimes(1);
  identity(f, f.convert.mock.calls[0]![1], f.a.attr, 'self_buy');
}, 60_000);

it.each(['absent', 'unbound', 'pending_auth', 'invalid'] as const)(
  '[AC-B1-06v#2] %s 查询已授权：插入或同 id CAS 置 active，以快照身份转链',
  async (binding) => {
    const f = await fixture(database(), { binding, query: true, scene: 'search' });
    const before = await f.bindings();
    const open = service(f);
    await success(await outcome(() => open.open(f.request())));
    expect(f.query).toHaveBeenCalledTimes(1);
    const [queried, ctx] = f.query.mock.calls[0]!;
    identity(f, queried, f.a.attr, 'self_buy');
    expect(ctx).toMatchObject({ appId: f.appId, purpose: 'online' });
    expect(JSON.stringify(f.query.mock.calls[0])).not.toMatch(/user_id|device_id/);
    expect(f.getActivePid).toHaveBeenCalledWith({
      appId: f.appId,
      platform: 'pdd',
      pidScene: 'self_buy',
      purpose: 'convert',
    });
    const rows = await f.bindings();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      app_id: f.appId,
      user_id: f.a.userId,
      status: 'active',
      union_account_id: f.accountId,
    });
    if (binding !== 'absent') {
      expect(rows[0]!.id).toBe(before[0]!.id);
      expect(rows[0]!.row_version).toBe(before[0]!.row_version + 1);
    }
    expect(JSON.parse(rows[0]!.pdd_custom!)).toEqual({ app: 'n', uid: f.a.attr, sc: 'self_buy' });
    expect(f.convert).toHaveBeenCalledTimes(1);
    expect(f.query.mock.invocationCallOrder[0]).toBeLessThan(f.fetch.mock.invocationCallOrder[0]!);
    expect(f.fetch.mock.invocationCallOrder[0]).toBeLessThan(
      f.convert.mock.invocationCallOrder[0]!,
    );
    identity(f, f.convert.mock.calls[0]![1], f.a.attr, 'self_buy');
    expect(await f.sessions()).toEqual([]);
  },
  60_000,
);

it('[AC-B1-06v#3] released 历史逐列不变，只插入当前账号的 active 行', async () => {
  const f = await fixture(database(), { binding: 'released', query: true });
  const before = await f.bindings();
  const open = service(f);
  await success(await outcome(() => open.open(f.request())));
  const rows = await f.bindings();
  expect(rows).toHaveLength(2);
  expect(rows.find((r) => r.id === f.bindingId)).toEqual(before[0]);
  const active = rows.find((r) => r.status === 'active');
  expect(active).toMatchObject({ union_account_id: f.accountId, user_id: f.a.userId });
  expect(active!.id).not.toBe(f.bindingId);
  expect(JSON.parse(active!.pdd_custom!)).toEqual({ app: 'n', uid: f.a.attr, sc: 'self_buy' });
  expect(f.query).toHaveBeenCalledTimes(1);
}, 60_000);

it('[AC-B1-06v#4] 查询返回前另一个事务插入 active：冲突重读后仍成功且仅一条未释放绑定', async () => {
  const f = await fixture(database(), { binding: 'absent', query: true });
  let competingId: string | null = null;
  f.query.mockImplementation(async () => {
    // Deterministic race: the competing commit finishes before the query resolves.
    competingId = await f.bind('active');
    return { authorized: true };
  });
  const open = service(f);
  await success(await outcome(() => open.open(f.request())));
  expect(f.query).toHaveBeenCalledTimes(1);
  expect(competingId).not.toBeNull();
  expect(await f.bindings()).toEqual([
    expect.objectContaining({ id: competingId, status: 'active', user_id: f.a.userId }),
  ]);
  expect(f.convert).toHaveBeenCalledTimes(1);
}, 60_000);

it('[AC-B1-06v#5] 无 attr_code 失败即关：50301，不查询、不签发会话、不改绑定', async () => {
  const f = await fixture(database(), { binding: 'invalid', query: true });
  const before = await f.bindings();
  // The reader is unavailable and the snapshot has no key; users.attr_code stays NOT NULL.
  f.attrCode.mockResolvedValue(null);
  await database()
    .updateTable('links')
    .set({
      identity_snapshot: {
        ...(f.row.identity_snapshot as Record<string, unknown>),
        attr_code: null,
      },
    })
    .where('app_id', '=', f.appId)
    .where('link_id', '=', f.row.link_id)
    .execute();
  const open = service(f);
  await response(await outcome(() => open.open(f.request())), 50301, 503);
  expect(f.query).not.toHaveBeenCalled();
  expect(await f.bindings()).toEqual(before);
  expect(await f.sessions()).toEqual([]);
  await noConversion(f);
}, 60_000);

it('[AC-B1-06v#6] 已缓存跳转后绑定变 invalid，新键必须再次查询，未授权不能复用跳转', async () => {
  const f = await fixture(database(), { binding: 'absent', query: true });
  const open = service(f);
  await success(await outcome(() => open.open(f.request())));
  expect(f.cache.put).toHaveBeenCalled();
  await database()
    .updateTable('union_bindings')
    .set({ status: 'invalid' })
    .where('app_id', '=', f.appId)
    .where('user_id', '=', f.a.userId)
    .execute();
  const before = await f.bindings();
  f.query.mockResolvedValue({ authorized: false });
  f.fetch.mockClear();
  f.convert.mockClear();
  await response(await outcome(() => open.open(f.request())), 30111, 422);
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.convert).not.toHaveBeenCalled();
  expect(await f.bindings()).toEqual(before);
  expect(await f.sessions()).toHaveLength(1);
  expect(await f.attempts()).toHaveLength(1);
}, 60_000);

it('[AC-B1-06v#7] 京东 absent 正常 200，不调用拼多多查询、不写拼多多绑定', async () => {
  const f = await fixture(database(), { binding: 'absent', query: false, platform: 'jd' });
  const open = service(f);
  await success(await outcome(() => open.open(f.request())));
  expect(f.query).not.toHaveBeenCalled();
  expect(await f.bindings()).toEqual([]);
  expect(await f.sessions()).toEqual([]);
  expect(f.convert).toHaveBeenCalledTimes(1);
}, 60_000);
