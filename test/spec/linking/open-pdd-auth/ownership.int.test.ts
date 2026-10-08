import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { databaseFixture } from './database.ts';
import { fixture, outcome, service } from './kit.ts';
import { identity, noAuthEntry, noConversion, response, success } from './assertions.ts';

const database = databaseFixture(createTestDatabase);
const shareCases = (['b', 'guest'] as const).flatMap((opener) =>
  (['absent', 'unbound', 'pending_auth', 'invalid', 'released', 'blocked'] as const).flatMap(
    (binding) => [false, true].map((noRebate) => ({ opener, binding, noRebate })),
  ),
);

it.each(shareCases)(
  '[AC-B1-06v#17] $opener 开分享者 $binding 的分享 link，no_rebate=$noRebate：30111 无授权入口，不查询',
  async ({ opener, binding, noRebate }) => {
    const f = await fixture(database(), { binding, query: false, scene: 'share' });
    // The opener's own active binding cannot authorize the sharer's snapshot.
    await f.bind('active', f.b.userId);
    f.opener(opener);
    const before = await f.bindings();
    const open = service(f);
    const result = await response(
      await outcome(() => open.open(f.request({ noRebate }))),
      30111,
      422,
    );
    noAuthEntry(result);
    expect(f.query).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await f.sessions()).toEqual([]);
    expect(await f.bindings()).toEqual(before);
    await noConversion(f);
  },
  60_000,
);

it.each(['b', 'guest'] as const)(
  '[AC-B1-06v#18] %s 打开已 active 分享者 link，保留 A 身份与 share 位且忽略 no_rebate',
  async (opener) => {
    const f = await fixture(database(), { binding: 'active', query: false, scene: 'share' });
    // Explicit B absence; only A has a row in this tenant.
    await f.bind('absent', f.b.userId);
    f.opener(opener);
    const before = await f.bindings();
    const open = service(f);
    const data = await success(await outcome(() => open.open(f.request({ noRebate: true }))));
    expect(data.new_link_id).toBeNull();
    expect(f.query).not.toHaveBeenCalled();
    expect(f.convert).toHaveBeenCalledTimes(1);
    identity(f, f.convert.mock.calls[0]![1], f.a.attr, 'share');
    expect(await f.bindings()).toEqual(before);
    expect(await f.sessions()).toEqual([]);
    expect(await f.logs()).toEqual([
      expect.objectContaining({
        user_id: f.a.userId,
        opener_user_id: opener === 'guest' ? null : f.b.userId,
        no_rebate: false,
      }),
    ]);
  },
  60_000,
);

it.each(['absent', 'blocked', 'active'] as const)(
  '[AC-B1-06v#19] 分享者 %s 且账号过期：未备案仍 30111，active 才 maintenance',
  async (binding) => {
    const f = await fixture(database(), { binding, query: true, scene: 'share' });
    f.opener('b');
    await f.expire();
    const before = await f.bindings();
    const open = service(f);
    const result = await response(
      await outcome(() => open.open(f.request())),
      binding === 'active' ? 50301 : 30111,
      binding === 'active' ? 503 : 422,
    );
    noAuthEntry(result);
    if (binding === 'active') expect(result.envelope.data).toEqual({ reason: 'maintenance' });
    expect(f.query).not.toHaveBeenCalled();
    expect(await f.sessions()).toEqual([]);
    expect(await f.bindings()).toEqual(before);
    await noConversion(f);
  },
  60_000,
);

it.each([false, true])(
  '[AC-B1-06v#20] B 打开 A 非分享 link：先新登记，查询 B，authorized=%s',
  async (authorized) => {
    const f = await fixture(database(), { binding: 'active', query: authorized });
    await f.bind('absent', f.b.userId);
    f.opener('b');
    const beforeA = (await f.bindings()).filter((r) => r.user_id === f.a.userId);
    const open = service(f);
    const result = await outcome(() => open.open(f.request()));
    await response(result, authorized ? 0 : 30111, authorized ? 200 : 422);
    expect(f.query).toHaveBeenCalledTimes(1);
    identity(f, f.query.mock.calls[0]![0], f.b.attr, 'self_buy');
    const links = await f.links();
    expect(links).toHaveLength(2);
    const served = links.find((row) => row.user_id === f.b.userId)!;
    expect(served.link_id).not.toBe(f.row.link_id);
    expect(served.identity_snapshot).toMatchObject({ user_id: f.b.userId, attr_code: f.b.attr });
    expect((await f.bindings()).filter((r) => r.user_id === f.a.userId)).toEqual(beforeA);
    if (authorized) {
      const data = await success(result);
      expect(data.new_link_id).toBe(served.link_id);
      identity(f, f.convert.mock.calls[0]![1], f.b.attr, 'self_buy');
      expect((await f.bindings()).filter((r) => r.user_id === f.b.userId)).toEqual([
        expect.objectContaining({ status: 'active' }),
      ]);
    } else {
      expect(await f.sessions()).toEqual([
        expect.objectContaining({
          user_id: f.b.userId,
          device_id: f.b.deviceId,
          link_id: served.link_id,
        }),
      ]);
      await noConversion(f);
    }
  },
  60_000,
);

it.each([false, true])(
  '[AC-B1-06v#21] A 打开自己的分享 link：改 self_buy 新 link，再判 A authorized=%s',
  async (authorized) => {
    const f = await fixture(database(), { binding: 'absent', query: authorized, scene: 'share' });
    const open = service(f);
    const result = await outcome(() => open.open(f.request()));
    await response(result, authorized ? 0 : 30111, authorized ? 200 : 422);
    expect(f.query).toHaveBeenCalledTimes(1);
    identity(f, f.query.mock.calls[0]![0], f.a.attr, 'self_buy');
    const links = await f.links();
    expect(links).toHaveLength(2);
    const served = links.find((r) => r.link_id !== f.row.link_id)!;
    expect(served).toMatchObject({ user_id: f.a.userId, pid_scene: 'self_buy' });
    if (authorized) {
      expect((await success(result)).new_link_id).toBe(served.link_id);
      identity(f, f.convert.mock.calls[0]![1], f.a.attr, 'self_buy');
    } else {
      expect(await f.sessions()).toEqual([
        expect.objectContaining({ link_id: served.link_id, user_id: f.a.userId }),
      ]);
      await noConversion(f);
    }
  },
  60_000,
);

it('[AC-B1-06v#22] 游客开非分享 link 10001，不查询、不新增绑定或授权会话', async () => {
  const f = await fixture(database(), { binding: 'absent', query: true });
  f.opener('guest');
  const open = service(f);
  await response(await outcome(() => open.open(f.request())), 10001, 401);
  expect(f.query).not.toHaveBeenCalled();
  expect(await f.sessions()).toEqual([]);
  expect(await f.bindings()).toEqual([]);
  await noConversion(f);
}, 60_000);
