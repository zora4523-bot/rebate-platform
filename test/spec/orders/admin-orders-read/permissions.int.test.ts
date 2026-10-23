import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture, useHarness } from '../../admin/auth/kit.ts';
import { seedUser } from '../../identity/registration/kit.ts';
import {
  PATH,
  UNATTRIBUTED,
  detail,
  ids,
  mounted,
  order,
  page,
  rejected,
  setup,
} from './kit.ts';

const h = useHarness();
const DENIED = { reason: 'admin_permission_denied' };

it.each([false, true])(
  '[AC-B1-10i#11] order.view 或超管可读本应用全部子订单（含未归因与其他用户），super=%s',
  async (isSuper) => {
    const s = await setup(h, { grants: isSuper ? [] : ['order.view'], isSuper });
    const mine = await order(s);
    const other = await order(s, { user_id: await seedUser(h.db, s.appId) });
    const nobody = await order(s, UNATTRIBUTED);
    const p = await page(await s.get());
    expect(ids(p).sort()).toEqual([mine.order_id, other.order_id, nobody.order_id].sort());
    expect(p.total).toBe(3);
    for (const o of [mine, other, nobody]) {
      expect((await detail(await s.get({}, o.order_id))).order_id).toBe(o.order_id);
    }
  },
);

it('[AC-B1-10i#12] 只有 user.lookup 时带 user_id 可读该用户的订单列表与详情，无需动态码', async () => {
  const s = await setup(h, { grants: ['user.lookup'] });
  const mine = await order(s);
  await order(s, { user_id: await seedUser(h.db, s.appId) });
  await order(s, UNATTRIBUTED);
  const p = await page(await s.get({ user_id: s.userId }));
  expect(ids(p)).toEqual([mine.order_id]);
  expect(p.total).toBe(1);
  const d = await detail(await s.get({ user_id: s.userId }, mine.order_id));
  expect(d).toMatchObject({ order_id: mine.order_id, user: { user_id: s.userId } });
});

it.each([{ grants: ['user.lookup'] }, { grants: [] }])(
  '[AC-B1-10i#13] 权限 %j 不带 user_id 时列表与详情都 10403',
  async ({ grants }) => {
    const s = await setup(h, { grants });
    const o = await order(s);
    for (const id of [undefined, o.order_id]) {
      await rejected(await s.get({}, id), 10403, DENIED);
    }
  },
);

it('[AC-B1-10i#14] 两个权限点都没有时带 user_id 仍 10403；伪造身份头无效', async () => {
  const s = await setup(h, { grants: [] });
  const o = await order(s);
  const forged = {
    'x-is-super': 'true',
    'x-admin-id': randomUUID(),
    'x-permissions': 'order.view',
  };
  for (const id of [undefined, o.order_id]) {
    await rejected(await s.get({ user_id: s.userId }, id, forged), 10403, DENIED);
  }
});

it.each(['order.view', 'user.lookup'])(
  '[AC-B1-10i#15] %s 带 user_id 读归属他人或未归因的订单详情报 20001 order_id',
  async (grant) => {
    const s = await setup(h, { grants: [grant] });
    const other = await order(s, { user_id: await seedUser(h.db, s.appId) });
    const nobody = await order(s, UNATTRIBUTED);
    for (const o of [other, nobody]) {
      await rejected(await s.get({ user_id: s.userId }, o.order_id), 20001, {
        fields: ['order_id'],
      });
    }
  },
);

it('[AC-B1-10i#16] 未知、非 UUID 与跨应用的 order_id 同样报 20001，身份头不能扩大应用范围', async () => {
  const s = await setup(h);
  const other = await setup(h);
  const foreign = await order(other);
  const own = await order(s);
  for (const id of [randomUUID(), 'not-an-order-id', foreign.order_id]) {
    await rejected(await s.get({}, id, { 'x-app-id': other.appId }), 20001, {
      fields: ['order_id'],
    });
  }
  const p = await page(await s.get({}, undefined, { 'x-app-id': other.appId }));
  expect(ids(p)).toEqual([own.order_id]);
  expect(await page(await s.get({ user_id: other.userId }))).toMatchObject({
    items: [],
    total: 0,
  });
  expect(await page(await s.get({ q: foreign.sub_order_id }))).toMatchObject({
    items: [],
    total: 0,
  });
});

it('[AC-B1-10i#17] 撤销权限后下一次读取立即 10403', async () => {
  const s = await setup(h);
  const o = await order(s);
  expect((await detail(await s.get({}, o.order_id))).order_id).toBe(o.order_id);
  await h.db
    .deleteFrom('admin_permissions')
    .where('app_id', '=', s.appId)
    .where('admin_id', '=', s.a.id)
    .execute();
  for (const id of [undefined, o.order_id]) {
    await rejected(await s.get({}, id), 10403, DENIED);
  }
});

it('[AC-B1-10i#18] 两个接口都必须登录后台', async () => {
  const s = await setup(h);
  const o = await order(s);
  for (const url of [PATH, `${PATH}/${o.order_id}`]) {
    await rejected(await s.f.app.inject({ method: 'GET', url }), 10001);
    await rejected(
      await s.f.app.inject({ method: 'GET', url, headers: { authorization: 'Bearer forged' } }),
      10001,
    );
  }
});

it('[AC-B1-10i#19] 列表与详情只在 admin 入口注册', async () => {
  const s = await setup(h);
  expect(mounted(s.f)).toEqual([true, true]);
  for (const entry of ['api', 'stream'] as const) {
    expect(mounted(await fixture(h, { entry }))).toEqual([false, false]);
  }
});
