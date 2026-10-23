// B1-22d / BR-ID-24 ③, 01 F-ADM-16, SPEC_REF 48e55e6: permission point union.account_auth, totp
// step-up on every start and credential entry, app isolation, admin entry only.
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture, useHarness } from '../../admin/auth/kit.ts';
import {
  BASE,
  CALLBACK,
  ROUTES,
  accepted,
  listed,
  okCode,
  rejected,
  seedAccount,
  setJdMode,
  setup,
  signIn,
  snapshot,
  started,
  type Admin,
  type Op,
  type ReauthResult,
  type Scenario,
} from './kit.ts';

const h = useHarness();

/** An oauth (taobao) and a manual (jd private_position) account, and a pending session. */
async function targets(s: Scenario, helper: Admin) {
  await setJdMode(s, 'private_position');
  const oauth = await seedAccount(s, { platform: 'taobao' });
  const manual = await seedAccount(s, { platform: 'jd' });
  const session = await started(helper, oauth.id);
  return { oauth, manual, session };
}

for (const grants of [[], ['union.pid', 'union.binding_reset']]) {
  it(`[B1-22d][BR-ID-24 ③] 缺 union.account_auth（授予 ${JSON.stringify(grants)}）五个接口都是 10403，带动态码也不行`, async () => {
    const s = await setup(h, { grants });
    const helper = await signIn(h, s.f, s.appId);
    const t = await targets(s, helper);
    const before = await snapshot(s);
    const calls: [Op, () => Promise<Awaited<ReturnType<Admin['list']>>>][] = [
      ['list', () => s.list()],
      ['start', () => s.start(t.oauth.id, {})],
      ['result', () => s.result(t.oauth.id, t.session.session_id)],
      ['callback', () => s.callback({ state: t.session.state, code: okCode('denied') })],
      ['credential', () => s.put(t.manual.id, { credential: 'fixture-denied-manual-key' })],
    ];
    for (const [op, call] of calls) {
      await rejected(await call(), op, 10403, { reason: 'admin_permission_denied' });
      expect(await snapshot(s), op).toEqual(before);
    }
    // The session refused to the account without permission is still usable by its creator.
    const done = await accepted<ReauthResult>(
      await helper.callback({ state: t.session.state, code: okCode('after-denied') }),
      'callback',
    );
    expect(done.status).toBe('succeeded');
  });
}

it('[B1-22d][BR-ID-24 ③] 超管不勾权限点也能查看、发起与录入（仍要动态码）', async () => {
  const s = await setup(h, { grants: [], isSuper: true });
  const t = await targets(s, s);
  expect((await listed(s)).length).toBe(2);
  await accepted(await s.result(t.oauth.id, t.session.session_id), 'result');
  await accepted(await s.put(t.manual.id, { credential: 'fixture-super-manual-key' }), 'credential');
  await rejected(await s.start(t.oauth.id, {}, { token: null }), 'start', 10003, { tier: 'totp' });
});

for (const op of ['start', 'credential'] as const) {
  it(`[B1-22d][BR-ID-24 ③] ${op} 每次都要有效的 totp 动态码；缺失、无效、他人会话的都是 10003`, async () => {
    const s = await setup(h);
    const other = await signIn(h, s.f, s.appId);
    await setJdMode(s, 'private_position');
    const oauth = await seedAccount(s, { platform: 'taobao' });
    const manual = await seedAccount(s, { platform: 'jd' });
    const before = await snapshot(s);
    const call = (token: string | null) =>
      op === 'start'
        ? s.start(oauth.id, { reason: '到期前提前续期' }, { token })
        : s.put(manual.id, { credential: 'fixture-step-up-manual-key' }, { token });
    for (const token of [null, 'invalid-step-up-token', await other.issue()]) {
      await rejected(await call(token), op, 10003, { tier: 'totp' });
      expect(await snapshot(s)).toEqual(before);
    }
  });

  it(`[B1-22d][BR-ID-24 ③] ${op} 成功即消耗动态码，同一动态码重放为 10003 且不再改动`, async () => {
    const s = await setup(h);
    await setJdMode(s, 'private_position');
    const oauth = await seedAccount(s, { platform: 'taobao' });
    const manual = await seedAccount(s, { platform: 'jd' });
    const token = await s.issue();
    const call = () =>
      op === 'start'
        ? s.start(oauth.id, {}, { token })
        : s.put(manual.id, { credential: 'fixture-replayed-manual-key' }, { token });
    await accepted(await call(), op);
    const after = await snapshot(s);
    await rejected(await call(), op, 10003, { tier: 'totp' });
    expect(await snapshot(s)).toEqual(after);
  });
}

it('[B1-22d][BR-ID-24 ③] 列表、会话结果与回调不要二次验证', async () => {
  const s = await setup(h);
  const oauth = await seedAccount(s, { platform: 'taobao' });
  const session = await started(s, oauth.id);
  await accepted(await s.list(), 'list');
  const pending = await accepted<ReauthResult>(
    await s.result(oauth.id, session.session_id),
    'result',
  );
  expect(pending.status).toBe('pending');
  const done = await accepted<ReauthResult>(
    await s.callback({ state: session.state, code: okCode('no-step-up') }),
    'callback',
  );
  expect(done.status).toBe('succeeded');
});

it('[B1-22d] 五个接口都要后台令牌，缺失为 10001', async () => {
  const s = await setup(h);
  await setJdMode(s, 'private_position');
  const oauth = await seedAccount(s, { platform: 'taobao' });
  const manual = await seedAccount(s, { platform: 'jd' });
  const session = await started(s, oauth.id);
  const before = await snapshot(s);
  const json = { 'content-type': 'application/json' };
  const requests: [Op, Parameters<Scenario['inject']>[0]][] = [
    ['list', { method: 'GET', url: BASE }],
    [
      'start',
      {
        method: 'POST',
        url: `${BASE}/${oauth.id}/reauthorize`,
        headers: { ...json, 'x-step-up-token': await s.issue() },
        payload: '{}',
      },
    ],
    ['result', { method: 'GET', url: `${BASE}/${oauth.id}/reauthorize/${session.session_id}` }],
    [
      'callback',
      {
        method: 'POST',
        url: CALLBACK,
        headers: json,
        payload: JSON.stringify({ state: session.state, code: okCode('anonymous') }),
      },
    ],
    [
      'credential',
      {
        method: 'PUT',
        url: `${BASE}/${manual.id}/credential`,
        headers: { ...json, 'x-step-up-token': await s.issue() },
        payload: JSON.stringify({ credential: 'fixture-anonymous-manual-key' }),
      },
    ],
  ];
  for (const [op, request] of requests) {
    await rejected(await s.inject(request), op, 10001);
    expect(await snapshot(s), op).toEqual(before);
  }
});

it('[B1-22d] 跨 app 的联盟账号不可见、不可操作；伪造 app 头无效', async () => {
  const s = await setup(h);
  const other = await setup(h);
  await setJdMode(other, 'private_position');
  const oauth = await seedAccount(other, { platform: 'taobao' });
  const manual = await seedAccount(other, { platform: 'jd' });
  const foreign = await started(other, oauth.id);
  const before = await snapshot(other);
  const forged = { 'x-app-id': other.appId, 'x-admin-id': other.a.id, 'x-is-super': 'true' };

  expect(await listed(s)).toEqual([]);
  await accepted(await s.list(forged), 'list');
  expect(await listed(s)).toEqual([]);
  for (const id of [oauth.id, randomUUID()]) {
    await rejected(await s.start(id, {}, { headers: forged }), 'start', 20001, {
      fields: ['union_account_id'],
    });
    await rejected(await s.result(id, foreign.session_id, forged), 'result', 20001, {
      fields: ['union_account_id'],
    });
  }
  for (const id of [manual.id, randomUUID()]) {
    await rejected(
      await s.put(id, { credential: 'fixture-foreign-manual-key' }, { headers: forged }),
      'credential',
      20001,
      { fields: ['union_account_id'] },
    );
  }
  await rejected(
    await s.callback({ state: foreign.state, code: okCode('foreign') }, forged),
    'callback',
    20001,
    { fields: ['state'] },
  );
  expect(await snapshot(other)).toEqual(before);
  const own = await snapshot(s);
  expect(own.sessions).toEqual([]);
  expect(own.credentials).toEqual([]);
  expect(own.audits).toEqual([]);
});

it('[B1-22d] 只有后台入口装配这五个接口，api 入口没有', async () => {
  const s = await setup(h);
  expect(await listed(s)).toEqual([]);
  const api = await fixture(h, { entry: 'api' });
  const server = api.app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  for (const [method, url] of ROUTES) {
    expect(server.hasRoute({ method, url }), `${method} ${url} on api`).toBe(false);
  }
});
