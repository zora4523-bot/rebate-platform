// B1-22g / BR-ID-24 细则「后台联盟账号列表」「后台告警手机号与重新授权会话」, 01 F-ADM-16,
// SPEC_REF 3a301d1: permission point union.account_auth (list without step-up, add / remove with
// the totp step-up on every call), admin token, app isolation, admin entry only.
import { expect, it } from 'vitest';
import { alertPhoneId } from '../../../../apps/api/src/modules/union/auth-expiry/service.ts';
import { fixture, useHarness } from '../../admin/auth/kit.ts';
import {
  BASE,
  ROUTES,
  accepted,
  idOf,
  maskedOf,
  masked,
  mobiles,
  phonesOf,
  query,
  rejected,
  seedPhones,
  setup,
  signIn,
  snapshot,
  stored,
  type Op,
  type Scenario,
} from './kit.ts';

const h = useHarness();

for (const grants of [[], ['union.pid', 'union.binding_reset']]) {
  it(`[B1-22g][F-ADM-16] 缺 union.account_auth（授予 ${JSON.stringify(grants)}）三个接口都是 10403，带动态码也不行`, async () => {
    const s = await setup(h, { grants });
    const [kept, fresh] = mobiles(2);
    await seedPhones(s, [kept!], 2);
    const keptId = alertPhoneId(s.h.fields, kept!);
    const before = await snapshot(s);
    const calls: [Op, () => ReturnType<Scenario['listPhones']>][] = [
      ['list', () => s.listPhones()],
      ['add', () => s.add({ phone: fresh, expected_version: 2 })],
      // Permission comes before the phone check.
      ['add', () => s.add({ phone: '12800138000', expected_version: 2 })],
      ['remove', () => s.remove({ phone_id: keptId, expected_version: 2 })],
    ];
    for (const [op, call] of calls) {
      await rejected(await call(), op, 10403, { reason: 'admin_permission_denied' });
      expect(await snapshot(s), op).toEqual(before);
    }
  });
}

it('[B1-22g][F-ADM-16] 超管不勾权限点也能查看与增删（增删仍要动态码）', async () => {
  const s = await setup(h, { grants: [], isSuper: true });
  const [phone] = mobiles(1);
  expect(await phonesOf(s)).toEqual({ version: 0, items: [] });
  const added = await accepted(await s.add({ phone, expected_version: 0 }), 'add');
  expect(maskedOf(added)).toEqual([masked(phone!)]);
  await rejected(
    await s.remove(
      { phone_id: idOf(added, phone!), expected_version: added.version },
      { token: null },
    ),
    'remove',
    10003,
    { tier: 'totp' },
  );
  const removed = await accepted(
    await s.remove({ phone_id: idOf(added, phone!), expected_version: added.version }),
    'remove',
  );
  expect(removed.items).toEqual([]);
});

it('[B1-22g][BR-ID-24 细则] 查看列表只要权限点，不要二次验证、不消耗动态码', async () => {
  const s = await setup(h);
  const [phone] = mobiles(1);
  await seedPhones(s, [phone!], 3);
  const token = await s.issue();
  const list = await accepted(await s.listPhones({ 'x-step-up-token': token }), 'list');
  expect(list.version).toBe(3);
  expect(maskedOf(list)).toEqual([masked(phone!)]);
  // The token the read did not consume still authorizes one write.
  const [other] = mobiles(1);
  await accepted(await s.add({ phone: other, expected_version: 3 }, { token }), 'add');
});

for (const op of ['add', 'remove'] as const) {
  it(`[B1-22g][F-ADM-16] ${op} 每次都要有效的 totp 动态码；缺失、无效、他人会话的都是 10003，什么都不写`, async () => {
    const s = await setup(h);
    const other = await signIn(h, s.f, s.appId);
    const [kept, fresh] = mobiles(2);
    await seedPhones(s, [kept!], 1);
    const keptId = alertPhoneId(s.h.fields, kept!);
    const before = await snapshot(s);
    const call = (token: string | null) =>
      op === 'add'
        ? s.add({ phone: fresh, expected_version: 1, reason: '新增值班运营手机号' }, { token })
        : s.remove({ phone_id: keptId, expected_version: 1 }, { token });
    for (const token of [null, 'invalid-step-up-token', await other.issue()]) {
      await rejected(await call(token), op, 10003, { tier: 'totp' });
      expect(await snapshot(s)).toEqual(before);
    }
    expect(await stored(s)).toEqual([kept]);
  });

  it(`[B1-22g][F-ADM-16] ${op} 成功即消耗动态码，同一动态码重放为 10003 且不再改动`, async () => {
    const s = await setup(h);
    const [kept, fresh] = mobiles(2);
    await seedPhones(s, [kept!], 1);
    const keptId = alertPhoneId(s.h.fields, kept!);
    const token = await s.issue();
    const call = (version: number) =>
      op === 'add'
        ? s.add({ phone: fresh, expected_version: version }, { token })
        : s.remove({ phone_id: keptId, expected_version: version }, { token });
    const done = await accepted(await call(1), op);
    expect(done.version).toBe(2);
    const after = await snapshot(s);
    await rejected(await call(2), op, 10003, { tier: 'totp' });
    expect(await snapshot(s)).toEqual(after);
  });
}

it('[B1-22g][F-ADM-16] 动态码检查先于号码检查：无动态码时不合格号码也是 10003', async () => {
  const s = await setup(h);
  const before = await snapshot(s);
  await rejected(
    await s.add({ phone: '12800138000', expected_version: 0 }, { token: null }),
    'add',
    10003,
    { tier: 'totp' },
  );
  expect(await snapshot(s)).toEqual(before);
});

it('[B1-22g] 三个接口都要后台令牌，缺失为 10001', async () => {
  const s = await setup(h);
  const [kept, fresh] = mobiles(2);
  await seedPhones(s, [kept!], 1);
  const before = await snapshot(s);
  const requests: [Op, Parameters<Scenario['inject']>[0]][] = [
    ['list', { method: 'GET', url: BASE }],
    [
      'add',
      {
        method: 'POST',
        url: BASE,
        headers: { 'content-type': 'application/json', 'x-step-up-token': await s.issue() },
        payload: JSON.stringify({ phone: fresh, expected_version: 1 }),
      },
    ],
    [
      'remove',
      {
        method: 'DELETE',
        url: `${BASE}${query({ phone_id: alertPhoneId(s.h.fields, kept!), expected_version: 1 })}`,
        headers: { 'x-step-up-token': await s.issue() },
      },
    ],
  ];
  for (const [op, request] of requests) {
    await rejected(await s.inject(request), op, 10001);
    expect(await snapshot(s), op).toEqual(before);
  }
});

it('[B1-22g][D10-152] 各 app 的告警手机号互不可见、不可操作；伪造 app 头无效', async () => {
  const s = await setup(h);
  const other = await setup(h);
  const [foreign, own] = mobiles(2);
  await seedPhones(other, [foreign!], 4);
  const foreignId = alertPhoneId(other.h.fields, foreign!);
  const before = await snapshot(other);
  const forged = { 'x-app-id': other.appId, 'x-admin-id': other.a.id, 'x-is-super': 'true' };

  expect(await phonesOf(s)).toEqual({ version: 0, items: [] });
  expect(await accepted(await s.listPhones(forged), 'list')).toEqual({ version: 0, items: [] });
  // The other app's version is not this app's version; its phone_id is not in this app's group.
  await rejected(
    await s.remove({ phone_id: foreignId, expected_version: 4 }, { headers: forged }),
    'remove',
    20902,
    { resource: 'config_item' },
  );
  await rejected(
    await s.remove({ phone_id: foreignId, expected_version: 0 }, { headers: forged }),
    'remove',
    20001,
    { fields: ['phone_id'] },
  );
  await rejected(
    await s.add({ phone: own, expected_version: 4 }, { headers: forged }),
    'add',
    20902,
    { resource: 'config_item' },
  );
  expect(await snapshot(other)).toEqual(before);
  expect(await snapshot(s)).toEqual({ config: undefined, history: [], audits: [] });

  // The same number in this app is this app's own group; the other app stays as it was.
  const mine = await accepted(await s.add({ phone: foreign, expected_version: 0 }), 'add');
  expect(mine.version).toBe(1);
  expect(maskedOf(mine)).toEqual([masked(foreign!)]);
  expect(await stored(s)).toEqual([foreign]);
  expect(await snapshot(other)).toEqual(before);
  expect(maskedOf(await phonesOf(other))).toEqual([masked(foreign!)]);
  expect((await phonesOf(other)).version).toBe(4);
});

it('[B1-22g] 只有后台入口装配这三个接口，api 入口没有', async () => {
  const s = await setup(h);
  expect(await phonesOf(s)).toEqual({ version: 0, items: [] });
  const api = await fixture(h, { entry: 'api' });
  const server = api.app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  for (const [method, url] of ROUTES) {
    expect(server.hasRoute({ method, url }), `${method} ${url} on api`).toBe(false);
  }
});
