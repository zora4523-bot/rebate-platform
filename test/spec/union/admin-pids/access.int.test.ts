import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture, useHarness } from '../../admin/auth/kit.ts';
import {
  BASE,
  WRITES,
  accepted,
  bodyFor,
  listed,
  rejected,
  seedPid,
  setup,
  snapshot,
} from './kit.ts';

const h = useHarness();

it('[AC-B1-22h#13] 列表缺 union.pid 返回 10403，其他 union 权限不能替代', async () => {
  const s = await setup(h, { grants: ['union.account_auth'] });
  await seedPid(s);
  const before = await snapshot(s);
  await rejected(await s.list(), 10403, { reason: 'admin_permission_denied' });
  expect(await snapshot(s)).toEqual(before);
});

for (const action of WRITES) {
  it(`[AC-B1-22h#14] ${action} 先拒绝缺少权限，不能以动态码代替权限`, async () => {
    const s = await setup(h, { grants: [] });
    const row = await seedPid(s, { status: action === 'retire' ? 'active' : 'pending' });
    const before = await snapshot(s);
    for (const token of [null, await s.issue()]) {
      await rejected(await s.write(action, row.id, bodyFor(action, row), { token }), 10403, {
        reason: 'admin_permission_denied',
      });
      expect(await snapshot(s)).toEqual(before);
    }
  });

  it.each([false, true])(
    `[AC-B1-22h#15] ${action} 每次需要有效 totp token，超管=%s`,
    async (isSuper) => {
      const s = await setup(h, { isSuper });
      const row = await seedPid(s, { status: action === 'retire' ? 'active' : 'pending' });
      const before = await snapshot(s);
      for (const token of [null, 'invalid-token']) {
        await rejected(await s.write(action, row.id, bodyFor(action, row), { token }), 10003, {
          tier: 'totp',
        });
        expect(await snapshot(s)).toEqual(before);
      }
    },
  );

  it(`[AC-B1-22h#16] ${action} 成功消耗动态码，重放不再修改；不要求 Idempotency-Key`, async () => {
    const s = await setup(h);
    const row = await seedPid(s, { status: action === 'retire' ? 'active' : 'pending' });
    const token = await s.issue();
    const body = bodyFor(action, row);
    await accepted(await s.write(action, row.id, body, { token }));
    const after = await snapshot(s);
    await rejected(await s.write(action, row.id, body, { token }), 10003, { tier: 'totp' });
    expect(await snapshot(s)).toEqual(after);
  });

  it(`[AC-B1-22h#17] ${action} 不接受另一后台会话的动态码`, async () => {
    const s = await setup(h);
    const other = await setup(h);
    const row = await seedPid(s, { status: action === 'retire' ? 'active' : 'pending' });
    const before = await snapshot(s);
    await rejected(
      await s.write(action, row.id, bodyFor(action, row), { token: await other.issue() }),
      10003,
      { tier: 'totp' },
    );
    expect(await snapshot(s)).toEqual(before);
  });
}

for (const action of ['update', 'activate', 'retire'] as const) {
  it(`[AC-B1-22h#18] ${action} 未知和跨 app 的 pid 均为 20001，伪造 app 头无效`, async () => {
    const s = await setup(h);
    const other = await setup(h);
    const row = await seedPid(other, { status: action === 'retire' ? 'active' : 'pending' });
    const before = await snapshot(other);
    for (const id of [randomUUID(), row.id]) {
      await rejected(
        await s.write(action, id, bodyFor(action, row), {
          headers: { 'x-app-id': other.appId, 'x-admin-id': other.a.id, 'x-is-super': 'true' },
        }),
        20001,
        { fields: ['pid_id'] },
      );
    }
    expect(await snapshot(other)).toEqual(before);
    expect(await s.rows()).toEqual([]);
    expect(await s.audits()).toEqual([]);
  });
}

it('[AC-B1-22h#19] 后台令牌不可缺失，推广位无 DELETE，api 入口不装配管理接口', async () => {
  const s = await setup(h);
  const row = await seedPid(s);
  expect(await listed(s)).toHaveLength(1); // Ensures this is red before routes exist.
  await rejected(await s.inject({ method: 'GET', url: BASE }), 10001);
  const response = await s.inject({
    method: 'DELETE',
    url: `${BASE}/${row.id}`,
    headers: { authorization: `Bearer ${s.session.admin_token}` },
  });
  expect(response.statusCode).toBe(404);
  expect(await s.rows()).toHaveLength(1);
  const api = await fixture(h, { entry: 'api' });
  const server = api.app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: string; url: string }): boolean;
  };
  for (const [method, url] of [
    ['GET', BASE],
    ['POST', BASE],
    ['PATCH', `${BASE}/:pid_id`],
    ['POST', `${BASE}/:pid_id/activate`],
    ['POST', `${BASE}/:pid_id/retire`],
  ]) {
    expect(server.hasRoute({ method: method!, url: url! })).toBe(false);
  }
});
