// B1-22o / CT-24s adminListUnionAccountOptions (D10-243), 04 §11.2, SPEC_REF ec81e62: permission
// point union.pid or union.account_auth (either is enough), lacking both is 10403
// admin_permission_denied; read only, no step-up (a step-up token is neither needed nor consumed);
// admin token required; app isolation; no audit row; admin entry only.
import { expect, it } from 'vitest';
import { fixture, useHarness } from '../../admin/auth/kit.ts';
import {
  ACCOUNT_AUTH,
  PATH,
  PID,
  accepted,
  optionOf,
  optionsOf,
  rejected,
  seedAccount,
  setup,
  signIn,
  snapshot,
} from './kit.ts';

const h = useHarness();

for (const grants of [[PID], [ACCOUNT_AUTH], [PID, ACCOUNT_AUTH]]) {
  it(`[B1-22o][D10-243] 持 ${JSON.stringify(grants)} 即可读取选项，不带动态码也是 200，且不写任何东西`, async () => {
    const s = await setup(h, { grants });
    const row = await seedAccount(s, { platform: 'jd', account_name: 'alpha' });
    const before = await snapshot(s);
    const items = await accepted(await s.options());
    expect(items).toEqual([optionOf(row)]);
    expect(await snapshot(s)).toEqual(before);
  });
}

for (const grants of [[], ['union.binding_reset'], ['user.list', 'config.general']]) {
  it(`[B1-22o][D10-243] union.pid 与 union.account_auth 都没有（授予 ${JSON.stringify(grants)}）为 10403 admin_permission_denied，带不带 platform、带不带动态码都一样`, async () => {
    const s = await setup(h, { grants });
    await seedAccount(s, { platform: 'taobao', account_name: 'alpha' });
    const token = await s.issue();
    const before = await snapshot(s);
    await rejected(await s.options(), 10403, { reason: 'admin_permission_denied' });
    await rejected(await s.options('taobao'), 10403, { reason: 'admin_permission_denied' });
    await rejected(await s.options(undefined, { 'x-step-up-token': token }), 10403, {
      reason: 'admin_permission_denied',
    });
    expect(await snapshot(s)).toEqual(before);
  });
}

it('[B1-22o] 超管不勾权限点也能读取选项', async () => {
  const s = await setup(h, { grants: [], isSuper: true });
  const row = await seedAccount(s, { platform: 'pdd', account_name: 'alpha' });
  expect(await optionsOf(s)).toEqual([optionOf(row)]);
});

it('[B1-22o][D10-243] 只读不要二次验证：带上的动态码不被消耗，之后仍能用于一次写操作', async () => {
  const s = await setup(h, { grants: [PID, ACCOUNT_AUTH] });
  const row = await seedAccount(s, { platform: 'taobao', account_name: 'alpha' });
  const token = await s.issue();
  const before = await snapshot(s);
  expect(await accepted(await s.options(undefined, { 'x-step-up-token': token }))).toEqual([
    optionOf(row),
  ]);
  expect(await accepted(await s.options('taobao', { 'x-step-up-token': token }))).toEqual([
    optionOf(row),
  ]);
  // An invalid token on a read is ignored too: the read never looks at step-up.
  expect(
    await accepted(await s.options(undefined, { 'x-step-up-token': 'invalid-step-up-token' })),
  ).toEqual([optionOf(row)]);
  expect(await snapshot(s)).toEqual(before);
  // The same token still authorizes one totp write of this admin (alert phone add, B1-22g).
  const added = await s.inject({
    method: 'POST',
    url: '/admin/v1/union-accounts/alert-phones',
    headers: { ...s.auth, 'content-type': 'application/json', 'x-step-up-token': token },
    payload: JSON.stringify({ phone: '13800138000', expected_version: 0 }),
  });
  expect(added.statusCode, JSON.stringify(added.json())).toBe(200);
  expect(added.json().code).toBe(0);
});

it('[B1-22o] 要后台令牌：缺失为 10001，无效令牌也不给数据', async () => {
  const s = await setup(h);
  await seedAccount(s, { platform: 'taobao', account_name: 'alpha' });
  const before = await snapshot(s);
  await rejected(await s.inject({ method: 'GET', url: PATH }), 10001);
  const forged = await s.inject({
    method: 'GET',
    url: PATH,
    headers: { authorization: 'Bearer not-an-admin-token' },
  });
  expect(forged.statusCode).toBe(401);
  expect(forged.json()).not.toHaveProperty('data.items');
  expect(await snapshot(s)).toEqual(before);
});

it('[B1-22o][BR-ATTR-02] 只列本 app 的联盟账号；伪造 app 头无效，他 app 的账号不出现', async () => {
  const s = await setup(h, { grants: [PID] });
  const other = await setup(h, { grants: [ACCOUNT_AUTH] });
  const mine = await seedAccount(s, { platform: 'taobao', account_name: 'mine' });
  const foreign = [
    await seedAccount(other, { platform: 'taobao', account_name: 'foreign' }),
    await seedAccount(other, { platform: 'jd', account_name: 'foreign' }),
  ];
  const forged = { 'x-app-id': other.appId, 'x-admin-id': other.a.id, 'x-is-super': 'true' };

  expect(await optionsOf(s)).toEqual([optionOf(mine)]);
  expect(await accepted(await s.options(undefined, forged))).toEqual([optionOf(mine)]);
  expect(await accepted(await s.options('jd', forged))).toEqual([]);
  const theirs = await optionsOf(other);
  expect(theirs.map((item) => item.union_account_id).sort()).toEqual(
    foreign.map((row) => row.id).sort(),
  );
  // A third app without any account sees an empty list, not another app's accounts.
  const empty = await setup(h, { grants: [PID] });
  expect(await optionsOf(empty)).toEqual([]);
});

it('[B1-22o] 同一 app 的两个后台账号（一个只持 union.pid、一个只持 union.account_auth）读到相同的选项', async () => {
  const s = await setup(h, { grants: [PID] });
  const peer = await signIn(h, s.f, s.appId, { grants: [ACCOUNT_AUTH] });
  await seedAccount(s, { platform: 'taobao', account_name: 'alpha' });
  await seedAccount(s, { platform: 'jd', account_name: 'bravo' });
  const items = await optionsOf(s);
  expect(items).toHaveLength(2);
  expect(await optionsOf(peer)).toEqual(items);
});

it('[B1-22o] 只有后台入口装配这个接口，api 入口没有', async () => {
  const s = await setup(h);
  expect(await optionsOf(s)).toEqual([]);
  const api = await fixture(h, { entry: 'api' });
  const server = api.app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  expect(server.hasRoute({ method: 'GET', url: PATH }), `GET ${PATH} on api`).toBe(false);
});
