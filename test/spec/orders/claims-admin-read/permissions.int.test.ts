import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture, useHarness } from '../../admin/auth/kit.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import { PATH, ZERO, detail, ids, page, rejected, seed, setup } from './kit.ts';

const h = useHarness();

it.each([false, true])(
  '[AC-B1-10j#1] order.claim 或超管可读本应用所有申请，super=%s',
  async (isSuper) => {
    const s = await setup(h, { grants: isSuper ? [] : ['order.claim'], isSuper });
    const another = await seedUser(h.db, s.appId);
    const a = await seed(s);
    const b = await seed(s, { user_id: another });
    const p = await page(await s.get());
    expect(ids(p).sort()).toEqual([a.id, b.id].sort());
    expect(p.total).toBe(2);
    for (const c of [a, b])
      expect((await detail(await s.get({}, c.id))).user.user_id).toBe(c.user_id);
  },
);

it('[AC-B1-10j#2] user.lookup 带 user_id 可读对应用户列表及详情，无需动态码', async () => {
  const s = await setup(h, { grants: ['user.lookup'] });
  const a = await seed(s);
  await seed(s, { user_id: await seedUser(h.db, s.appId) });
  const p = await page(await s.get({ user_id: s.userId }));
  expect(ids(p)).toEqual([a.id]);
  expect(p.counts).toEqual({ ...ZERO, manual_review: 1 });
  expect((await detail(await s.get({ user_id: s.userId }, a.id))).claim_id).toBe(a.id);
});

it.each([{ grants: ['user.lookup'] }, { grants: [] }])(
  '[AC-B1-10j#3] 权限 %j 无 user_id 时两个接口都拒绝',
  async ({ grants }) => {
    const s = await setup(h, { grants });
    const c = await seed(s);
    for (const id of [undefined, c.id]) {
      await rejected(await s.get({}, id), 10403, { reason: 'admin_permission_denied' });
    }
  },
);

it('[AC-B1-10j#4] 两权限均无时带 user_id 仍拒绝；伪造身份头无效', async () => {
  const s = await setup(h, { grants: [] });
  const c = await seed(s);
  for (const id of [undefined, c.id]) {
    await rejected(
      await s.get({ user_id: s.userId }, id, { 'x-is-super': 'true', 'x-admin-id': randomUUID() }),
      10403,
      { reason: 'admin_permission_denied' },
    );
  }
});

it.each(['order.claim', 'user.lookup'])(
  '[AC-B1-10j#5] %s 带 user_id 不能读取另一申请人的 claim',
  async (grant) => {
    const s = await setup(h, { grants: [grant] });
    const c = await seed(s, { user_id: await seedUser(h.db, s.appId) });
    await rejected(await s.get({ user_id: s.userId }, c.id), 20001, { fields: ['claim_id'] });
  },
);

it('[AC-B1-10j#6] 未知 claim 与跨应用 claim 同样报 20001，身份头不能扩大应用范围', async () => {
  const s = await setup(h);
  const other = await setup(h);
  const foreign = await seed(other);
  const own = await seed(s);
  for (const id of [randomUUID(), foreign.id]) {
    await rejected(await s.get({}, id, { 'x-app-id': other.appId }), 20001, {
      fields: ['claim_id'],
    });
  }
  const p = await page(await s.get({}, undefined, { 'x-app-id': other.appId }));
  expect(ids(p)).toEqual([own.id]);
  expect(p.counts).toEqual({ ...ZERO, manual_review: 1 });
  expect(await page(await s.get({ user_id: other.userId }))).toMatchObject({
    items: [],
    total: 0,
    counts: ZERO,
  });
});

it('[AC-B1-10j#7] 权限撤销后下一次读取立即拒绝', async () => {
  const s = await setup(h);
  const c = await seed(s);
  expect((await detail(await s.get({}, c.id))).claim_id).toBe(c.id);
  await h.db
    .deleteFrom('admin_permissions')
    .where('app_id', '=', s.appId)
    .where('admin_id', '=', s.a.id)
    .execute();
  for (const id of [undefined, c.id])
    await rejected(await s.get({}, id), 10403, { reason: 'admin_permission_denied' });
});

it('[AC-B1-10j#8] 两接口必须登录后台', async () => {
  const s = await setup(h);
  const c = await seed(s);
  for (const url of [PATH, `${PATH}/${c.id}`]) {
    await rejected(await s.f.app.inject({ method: 'GET', url }), 10001);
  }
});

it('[AC-B1-10j#9] 只在 admin 入口注册列表及详情', async () => {
  const s = await setup(h);
  for (const url of [PATH, `${PATH}/:claim_id`]) {
    expect(s.f.app.getHttpAdapter().getInstance().hasRoute({ method: 'GET', url })).toBe(true);
  }
  for (const entry of ['api', 'stream'] as const) {
    const f = await fixture(h, { entry });
    for (const url of [PATH, `${PATH}/:claim_id`]) {
      expect(f.app.getHttpAdapter().getInstance().hasRoute({ method: 'GET', url })).toBe(false);
    }
  }
});
