import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { fixture, useHarness } from '../../admin/auth/kit.ts';
import { ACTIONS, setup, prepare, permission, rejected, accepted } from './kit.ts';
const h = useHarness();

it('[AC-F1-07d#35] 风控写路由只挂 admin 入口', async () => {
  const s = await setup(h);
  const adminServer = s.f.app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(input: { method: 'PUT'; url: string }): boolean;
  };
  expect(adminServer.hasRoute({ method: 'PUT', url: '/admin/v1/users/:user_id/risk-state' })).toBe(
    true,
  );
  for (const entry of ['api', 'stream'] as const) {
    const f = await fixture(h, { entry });
    const server = f.app.getHttpAdapter().getInstance() as unknown as typeof adminServer;
    expect(server.hasRoute({ method: 'PUT', url: '/admin/v1/users/:user_id/risk-state' })).toBe(
      false,
    );
  }
});

it.each(ACTIONS)('[AC-F1-07d#36] %s 已过期的动态码不能操作', async (action) => {
  const s = await setup(h);
  const input = await prepare(s, action);
  const token = await s.issue();
  s.f.clock.advanceMs(300_001);
  const before = await s.snapshot();
  await rejected(await s.put(input, { token }), 10003, { tier: 'totp' });
  expect(await s.snapshot()).toEqual(before);
});

it.each([undefined, 'delete', 1])('[AC-F1-07d#37] action 必填且限四个动作：%s', async (action) => {
  const s = await setup(h);
  const input = await prepare(s, 'ban');
  const before = await s.snapshot();
  await rejected(await s.put({ ...input, action }), 20001, { fields: ['action'] });
  expect(await s.snapshot()).toEqual(before);
});

it.each(ACTIONS)('[AC-F1-07d#1] %s 按动作鉴权，另一权限不能替代', async (action) => {
  const s = await setup(h, {
    grants: [permission(action) === 'risk.ban' ? 'risk.freeze' : 'risk.ban'],
  });
  const input = await prepare(s, action);
  const before = await s.snapshot();
  const token = await s.issue();
  await rejected(await s.put(input, { token }), 10403, { reason: 'admin_permission_denied' });
  expect(await s.snapshot()).toEqual(before);
  await h.db
    .insertInto('admin_permissions')
    .values({
      app_id: s.appId,
      admin_id: s.a.id,
      permission_key: permission(action),
      granted_by: s.a.id,
      granted_at: s.f.clock.now(),
    })
    .execute();
  await accepted(await s.put(input, { token }));
});
for (const action of ACTIONS) {
  it.each([false, true])(`[AC-F1-07d#2] ${action} 必须有有效 totp，超管=%s`, async (isSuper) => {
    const s = await setup(h, { isSuper });
    const input = await prepare(s, action);
    const before = await s.snapshot();
    for (const token of [null, 'invalid-step-up-token']) {
      await rejected(await s.put(input, { token }), 10003, { tier: 'totp' });
      expect(await s.snapshot()).toEqual(before);
    }
  });
  it.each([undefined, null, '', '因'.repeat(201)])(
    `[AC-F1-07d#3] ${action} 非法原因 %s`,
    async (reason) => {
      const s = await setup(h);
      const input = await prepare(s, action);
      const before = await s.snapshot();
      await rejected(await s.put({ ...input, reason }), 20001, { fields: ['reason'] });
      expect(await s.snapshot()).toEqual(before);
    },
  );
  it.each(['因', '因'.repeat(200)])(
    `[AC-F1-07d#4] ${action} 原因边界 %s，无需幂等键`,
    async (reason) => {
      const s = await setup(h);
      const input = await prepare(s, action);
      expect(await accepted(await s.put({ ...input, reason }))).toMatchObject({ reason });
    },
  );
  it.each([undefined, -1, 1.5, '7'])(
    `[AC-F1-07d#5] ${action} 版本字段非法 %s`,
    async (expected_row_version) => {
      const s = await setup(h);
      const input = await prepare(s, action);
      const before = await s.snapshot();
      await rejected(await s.put({ ...input, expected_row_version }), 20001, {
        fields: ['expected_row_version'],
      });
      expect(await s.snapshot()).toEqual(before);
    },
  );
  it(`[AC-F1-07d#6] ${action} 拒绝未知用户及跨 app 目标，身份头不能越权`, async () => {
    const s = await setup(h);
    const other = await setup(h);
    const input = await prepare(other, action);
    const before = await other.snapshot();
    for (const userId of [randomUUID(), other.userId]) {
      await rejected(
        await s.put(input, {
          userId,
          headers: { 'x-app-id': other.appId, 'x-admin-id': other.a.id, 'x-is-super': 'true' },
        }),
        20001,
        { fields: ['user_id'] },
      );
    }
    expect(await other.snapshot()).toEqual(before);
    expect(await s.riskAudits()).toEqual([]);
  });
  it.each(
    action === 'ban' || action === 'freeze' ? [undefined, null, 'not-a-category'] : ['other', null],
  )(`[AC-F1-07d#7] ${action} reason_category 条件校验 %s`, async (reason_category) => {
    const s = await setup(h);
    const input = await prepare(s, action);
    const before = await s.snapshot();
    await rejected(await s.put({ ...input, reason_category }), 20001, {
      fields: ['reason_category'],
    });
    expect(await s.snapshot()).toEqual(before);
  });
  if (action !== 'freeze') {
    it.each([null, '2090-01-01T00:00:00Z'])(
      `[AC-F1-07d#8] ${action} 不接受 frozen_until=%s`,
      async (frozen_until) => {
        const s = await setup(h);
        const input = await prepare(s, action);
        const before = await s.snapshot();
        await rejected(await s.put({ ...input, frozen_until }), 20001, {
          fields: ['frozen_until'],
        });
        expect(await s.snapshot()).toEqual(before);
      },
    );
  }
}
it.each(['past', 'equal', 'invalid'] as const)(
  '[AC-F1-07d#9] 冻结截止时刻 %s 被拒绝',
  async (kind) => {
    const s = await setup(h);
    const input = await prepare(s, 'freeze');
    const token = await s.issue();
    const frozen_until =
      kind === 'invalid'
        ? 'tomorrow'
        : new Date(s.f.clock.now().getTime() - (kind === 'past' ? 1 : 0)).toISOString();
    const before = await s.snapshot();
    await rejected(await s.put({ ...input, frozen_until }, { token }), 20001, {
      fields: ['frozen_until'],
    });
    expect(await s.snapshot()).toEqual(before);
  },
);
it.each([undefined, null, '9999-01-01T00:00:00Z'])(
  '[AC-F1-07d#10] 冻结期限无上限，空为不定期 %s',
  async (frozen_until) => {
    const s = await setup(h);
    const input = await prepare(s, 'freeze');
    expect(await accepted(await s.put({ ...input, frozen_until }))).toMatchObject({
      state: 'frozen',
      frozen_until: frozen_until == null ? null : '9999-01-01T00:00:00.000Z',
    });
  },
);
