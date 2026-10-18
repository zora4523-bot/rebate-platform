import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import {
  ACTIONS,
  REASON,
  setup,
  binding,
  snapshot,
  rejected,
  accepted,
  permission,
} from './kit.ts';

const h = useHarness();

it.each(ACTIONS)('[AC-F1-07c#6] %s 精确权限点，另一权限不能替代', async (action) => {
  const wrong =
    permission(action) === 'union.binding_reset' ? 'union.binding_disable' : 'union.binding_reset';
  const s = await setup(h, { grants: [wrong] });
  const row = await binding(
    s,
    action === 'enable' ? { status: 'blocked', blocked_reason: 'admin_disable' } : {},
  );
  const before = await snapshot(s);
  const token = await s.issue();
  await rejected(
    await s.post(action, { reason: REASON, expected_row_version: row.row_version }, { token }),
    10403,
    { reason: 'admin_permission_denied' },
  );
  expect(await snapshot(s)).toEqual(before);
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
  await accepted(
    await s.post(action, { reason: REASON, expected_row_version: row.row_version }, { token }),
  );
  expect(await s.audits()).toHaveLength(1);
});

for (const action of ACTIONS) {
  it.each([false, true])(
    `[AC-F1-07c#7] ${action} 缺失或无效动态码均拒绝，超管=%s`,
    async (isSuper) => {
      const s = await setup(h, { isSuper });
      const row = await binding(
        s,
        action === 'enable' ? { status: 'blocked', blocked_reason: 'admin_disable' } : {},
      );
      const before = await snapshot(s);
      for (const token of [null, 'invalid-step-up-token']) {
        await rejected(
          await s.post(
            action,
            { reason: REASON, expected_row_version: row.row_version },
            { token },
          ),
          10003,
          { tier: 'totp' },
        );
        expect(await snapshot(s)).toEqual(before);
      }
    },
  );

  it.each([undefined, null, '', '因'.repeat(201)])(
    `[AC-F1-07c#8] ${action} 原因必填且最长 200 字：%s`,
    async (reason) => {
      const s = await setup(h);
      const row = await binding(
        s,
        action === 'enable' ? { status: 'blocked', blocked_reason: 'admin_disable' } : {},
      );
      const before = await snapshot(s);
      await rejected(
        await s.post(action, { reason, expected_row_version: row.row_version }),
        20001,
        { fields: ['reason'] },
      );
      expect(await snapshot(s)).toEqual(before);
    },
  );

  it.each(['因', '因'.repeat(200)])(
    `[AC-F1-07c#9] ${action} 原因长度边界合法，不要求 Idempotency-Key：%s`,
    async (reason) => {
      const s = await setup(h);
      const row = await binding(
        s,
        action === 'enable' ? { status: 'blocked', blocked_reason: 'admin_disable' } : {},
      );
      expect(
        await accepted(await s.post(action, { reason, expected_row_version: row.row_version })),
      ).toMatchObject({ reason });
    },
  );

  it.each([undefined, null, -1, 1.5, '7'])(
    `[AC-F1-07c#10] ${action} 版本号必须是非负整数：%s`,
    async (expected) => {
      const s = await setup(h);
      await binding(s);
      const before = await snapshot(s);
      await rejected(
        await s.post(action, { reason: REASON, expected_row_version: expected }),
        20001,
        { fields: ['expected_row_version'] },
      );
      expect(await snapshot(s)).toEqual(before);
    },
  );

  it(`[AC-F1-07c#11] ${action} 未知用户与无用户授权的平台明确拒绝`, async () => {
    const s = await setup(h);
    const row = await binding(s);
    const before = await snapshot(s);
    await rejected(
      await s.post(
        action,
        { reason: REASON, expected_row_version: row.row_version },
        { userId: randomUUID() },
      ),
      20001,
      { fields: ['user_id'] },
    );
    await rejected(
      await s.post(
        action,
        { reason: REASON, expected_row_version: row.row_version },
        { platform: 'jd' },
      ),
      20001,
      { fields: ['platform'] },
    );
    expect(await snapshot(s)).toEqual(before);
  });

  it(`[AC-F1-07c#12] ${action} 不接受跨 app 的用户，伪造请求头不能越权`, async () => {
    const s = await setup(h);
    const other = await setup(h);
    const row = await binding(
      other,
      action === 'enable' ? { status: 'blocked', blocked_reason: 'admin_disable' } : {},
    );
    const before = await snapshot(other);
    await rejected(
      await s.post(
        action,
        { reason: REASON, expected_row_version: row.row_version },
        {
          userId: other.userId,
          headers: { 'x-app-id': other.appId, 'x-admin-id': other.a.id, 'x-is-super': 'true' },
        },
      ),
      20001,
      { fields: ['user_id'] },
    );
    expect(await snapshot(other)).toEqual(before);
    expect(await s.audits()).toEqual([]);
  });
}
