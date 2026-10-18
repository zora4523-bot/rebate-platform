import { expect, it } from 'vitest';
import { fixture, useHarness } from '../../admin/auth/kit.ts';
import {
  ACTIONS,
  STATES,
  REASON,
  setup,
  binding,
  current,
  risk,
  snapshot,
  accepted,
  rejected,
} from './kit.ts';

const h = useHarness();

for (const action of ACTIONS) {
  for (const platform of ['taobao', 'pdd']) {
    for (const [status, blockedReason] of STATES) {
      it(`[AC-F1-07c#1] ${platform} ${action} 状态表 ${status}/${blockedReason}`, async () => {
        const s = await setup(h);
        const row =
          status === 'absent'
            ? undefined
            : await binding(s, {
                platform,
                status,
                blocked_reason: blockedReason,
              });
        const before = await snapshot(s);
        const allowed =
          action === 'enable'
            ? status === 'blocked' && blockedReason === 'admin_disable'
            : status === 'active' || status === 'invalid';
        const response = await s.post(
          action,
          {
            reason: REASON,
            expected_row_version: row?.row_version ?? 0,
          },
          { platform },
        );
        if (action === 'reset' && platform !== 'taobao') {
          await rejected(response, 20001, { fields: ['platform'] });
          expect(await snapshot(s)).toEqual(before);
          return;
        }
        if (!allowed) {
          await rejected(response, 30154);
          expect(await snapshot(s)).toEqual(before);
          return;
        }
        const data = await accepted(response);
        expect(row).toBeDefined();
        const after = await current(s, row!.id);
        const target =
          action === 'reset'
            ? 'released'
            : action === 'disable'
              ? 'blocked'
              : platform === 'taobao'
                ? 'invalid'
                : 'active';
        expect(after).toMatchObject({
          id: row!.id,
          app_id: s.appId,
          user_id: s.userId,
          platform,
          union_account_id: row!.union_account_id,
          relation_id: row!.relation_id,
          bound_at: row!.bound_at,
          status: target,
          reason: REASON,
          blocked_reason: action === 'disable' ? 'admin_disable' : null,
        });
        if (action === 'enable' && platform !== 'taobao') {
          // 非淘宝恢复立即生效，不规定内部迁移步数。
          expect(after.row_version).toBeGreaterThan(row!.row_version);
        } else expect(after.row_version).toBe(row!.row_version + 1);
        expect(data).toEqual({
          platform,
          status: target,
          blocked_reason: after.blocked_reason,
          bound_at: after.bound_at?.toISOString() ?? null,
          released_at: after.released_at?.toISOString() ?? null,
          cooldown_until: after.cooldown_until?.toISOString() ?? null,
          reason: REASON,
          row_version: after.row_version,
        });
        if (action === 'reset') {
          expect(after.released_at).toEqual(s.f.clock.now());
          expect(after.cooldown_until).toEqual(
            new Date(s.f.clock.now().getTime() + 30 * 86_400_000),
          );
        } else {
          expect(after.released_at).toBeNull();
          expect(after.cooldown_until).toBeNull();
        }
        const audits = await s.audits();
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({
          app_id: s.appId,
          admin_id: s.a.id,
          action: `union_binding_${action}`,
          before: { status },
          after: { status: target, reason: REASON },
          at: s.f.clock.now(),
        });
      });
    }
  }
}

it.each([1, 17, 45])('[AC-F1-07c#2] reset 冷却读取配置 %i 天并采用注入时钟', async (days) => {
  const s = await setup(h);
  const row = await binding(s);
  await h.db
    .insertInto('config_items')
    .values({
      app_id: s.appId,
      key: 'bind.rebind_cooldown_days',
      value: JSON.stringify(days),
      updated_by: 'synthetic',
    })
    .execute();
  s.f.clock.set('2026-10-09T02:02:00.123Z');
  const response = await s.post('reset', { reason: REASON, expected_row_version: row.row_version });
  await accepted(response);
  expect(await current(s, row.id)).toMatchObject({
    released_at: s.f.clock.now(),
    cooldown_until: new Date(s.f.clock.now().getTime() + days * 86_400_000),
  });
});

it.each(['taobao', 'pdd'])(
  '[AC-F1-07c#3] banned 用户 %s 的 admin_disable 不能 enable',
  async (platform) => {
    const s = await setup(h);
    const row = await binding(s, { platform, status: 'blocked', blocked_reason: 'admin_disable' });
    await risk(s, 'banned');
    const before = await snapshot(s);
    await rejected(
      await s.post(
        'enable',
        {
          reason: REASON,
          expected_row_version: row.row_version,
        },
        { platform },
      ),
      30154,
    );
    expect(await snapshot(s)).toEqual(before);
  },
);

it.each(ACTIONS)(
  '[AC-F1-07c#4] %s 的旧版本和未来版本均返回 union_binding CAS 冲突',
  async (action) => {
    const s = await setup(h);
    const row = await binding(
      s,
      action === 'enable' ? { status: 'blocked', blocked_reason: 'admin_disable' } : {},
    );
    const before = await snapshot(s);
    for (const version of [row.row_version - 1, row.row_version + 1]) {
      await rejected(
        await s.post(action, { reason: REASON, expected_row_version: version }),
        20902,
        { resource: 'union_binding' },
      );
      expect(await snapshot(s)).toEqual(before);
    }
  },
);

it('[AC-F1-07c#5] 两个后台请求争用同一版本，最多一笔变更和一条审计', async () => {
  const s = await setup(h);
  const row = await binding(s);
  const tokens = [await s.issue(), await s.issue()];
  const results = await Promise.all(
    ['reset', 'disable'].map((action, index) =>
      s.post(
        action as 'reset' | 'disable',
        { reason: REASON, expected_row_version: row.row_version },
        { token: tokens[index]! },
      ),
    ),
  );
  expect(results.filter((r) => r.json().code === 0)).toHaveLength(1);
  expect(results.filter((r) => [20902, 30154].includes(r.json().code))).toHaveLength(1);
  expect((await current(s, row.id)).row_version).toBe(row.row_version + 1);
  expect(await s.audits()).toHaveLength(1);
});

it('[AC-F1-07c#25] 联盟授权管理路由只挂后台入口', async () => {
  const s = await setup(h);
  const row = await binding(s);
  await accepted(await s.post('reset', { reason: REASON, expected_row_version: row.row_version }));
  const api = await fixture(h, { entry: 'api' });
  const server = api.app.getHttpAdapter().getInstance() as unknown as {
    hasRoute(options: { method: 'POST'; url: string }): boolean;
  };
  for (const action of ACTIONS) {
    expect(
      server.hasRoute({
        method: 'POST',
        url: `/admin/v1/users/:user_id/union-bindings/:platform/${action}`,
      }),
    ).toBe(false);
  }
});
