// B1-03zd: risk.appeal (no step-up) guards all three reads; a super admin holds every point; the
// routes exist on the admin entry only and need an admin session.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture, useHarness } from '../../admin/auth/kit.ts';
import {
  BLOCKED,
  DENIED,
  LIST,
  accountAppeal,
  audits,
  blocked,
  detail,
  found,
  member,
  mounted,
  page,
  rejected,
  setup,
  at,
  HOUR,
  type Scenario,
} from './kit.ts';

const h = useHarness();

async function seeded(s: Scenario) {
  const user = await member(s, { state: 'appealing' });
  const row = await accountAppeal(s, user, 'banned');
  const b = await blocked(s, { request_type: 'withdraw', user, blocked_at: at(-HOUR) });
  return { user, row, b };
}

it.each<[string, readonly string[]]>([
  ['没有任何权限', []],
  [
    '只有其他风控与用户权限',
    ['risk.ban', 'risk.freeze', 'risk.blocklist', 'user.lookup', 'order.view'],
  ],
])('[AC-B1-03zd#10] %s → 三个接口都 10403 admin_permission_denied', async (_label, grants) => {
  const s = await setup(h, { grants });
  const { user, row, b } = await seeded(s);
  await rejected(await s.list(), 10403, DENIED);
  await rejected(await s.detail(row.id), 10403, DENIED);
  for (const query of [
    { user_id: user.id },
    { blocked_request_id: b.id },
    { phone: user.phone! },
  ]) {
    await rejected(await s.lookup(query), 10403, DENIED);
  }
  // A refused phone lookup is no lookup: nothing is audited.
  expect(await audits(s)).toEqual([]);
});

it('[AC-B1-03zd#11] 超管不需单独授权即可读三个接口', async () => {
  const s = await setup(h, { grants: [], isSuper: true });
  const { user, row, b } = await seeded(s);
  expect((await page(await s.list())).items.map((i) => i.appeal_id)).toEqual([row.id]);
  expect((await detail(await s.detail(row.id))).appeal_id).toBe(row.id);
  expect((await found(await s.lookup({ user_id: user.id }))).items[0]?.blocked_request_id).toBe(
    b.id,
  );
});

it('[AC-B1-03zd#12] 只持 risk.appeal 即可读，不需动态码；无效的 step-up 头被忽略', async () => {
  const s = await setup(h);
  const { user, row, b } = await seeded(s);
  const headers = { 'x-step-up-token': 'not-a-valid-step-up-token' };
  expect((await page(await s.list({}, headers))).total).toBe(1);
  expect((await detail(await s.detail(row.id, headers))).appeal_id).toBe(row.id);
  expect((await found(await s.lookup({ user_id: user.id }, headers))).total).toBe(1);
  expect((await found(await s.lookup({ blocked_request_id: b.id }))).total).toBe(1);
});

it('[AC-B1-03zd#13] 撤销 risk.appeal 后下一次读取立即 10403', async () => {
  const s = await setup(h);
  const { user, row } = await seeded(s);
  expect((await page(await s.list())).total).toBe(1);
  await h.db
    .deleteFrom('admin_permissions')
    .where('app_id', '=', s.appId)
    .where('admin_id', '=', s.a.id)
    .execute();
  await rejected(await s.list(), 10403, DENIED);
  await rejected(await s.detail(row.id), 10403, DENIED);
  await rejected(await s.lookup({ user_id: user.id }), 10403, DENIED);
});

it('[AC-B1-03zd#14] 伪造身份头不能越权或换应用', async () => {
  const s = await setup(h, { grants: [] });
  const other = await setup(h);
  const { row } = await seeded(other);
  const forged = {
    'x-is-super': 'true',
    'x-admin-id': other.a.id,
    'x-app-id': other.appId,
    'x-permissions': 'risk.appeal',
  };
  await rejected(await s.list({}, forged), 10403, DENIED);
  await rejected(await s.detail(row.id, forged), 10403, DENIED);
});

it('[AC-B1-03zd#15] 三个接口都必须登录后台', async () => {
  const s = await setup(h);
  const { row } = await seeded(s);
  for (const url of [LIST, `${LIST}/${row.id}`, `${BLOCKED}?user_id=${randomUUID()}`]) {
    await rejected(await s.f.app.inject({ method: 'GET', url }), 10001);
    await rejected(
      await s.f.app.inject({ method: 'GET', url, headers: { authorization: 'Bearer forged' } }),
      10001,
    );
  }
});

it('[AC-B1-03zd#16] 三个接口只在 admin 入口注册', async () => {
  const s = await setup(h);
  expect(mounted(s.f)).toEqual([true, true, true]);
  for (const entry of ['api', 'stream'] as const) {
    expect(mounted(await fixture(h, { entry })), entry).toEqual([false, false, false]);
  }
});
