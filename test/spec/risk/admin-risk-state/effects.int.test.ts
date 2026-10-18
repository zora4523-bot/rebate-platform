import { expect, it } from 'vitest';
import { useHarness } from '../../admin/auth/kit.ts';
import { setup, binding, current, body, accepted, seedState } from './kit.ts';
import { userSessions } from './service-kit.ts';
const h = useHarness();

it('[AC-F1-07d#15] 封禁吊销全部设备会话和刷新链，解封不复活旧凭据', async () => {
  const s = await setup(h);
  const sessions = await userSessions(s);
  // Prime a rotated token's grace entry too: it must not bypass the revoked sid.
  expect((await sessions.refresh(sessions.first)).code).toBe(0);
  const other = await setup(h);
  const unrelated = await userSessions(other);
  const before = await other.snapshot();
  await accepted(await s.put(body('ban')));
  expect(await s.sessions()).toHaveLength(2);
  for (const row of await s.sessions())
    expect(row).toMatchObject({ revoked_at: s.f.clock.now(), revoke_reason: 'banned' });
  for (const pair of [sessions.first, sessions.second]) {
    await expect(sessions.access(pair)).rejects.toMatchObject({ code: 10002 });
    expect(await sessions.refresh(pair)).toEqual({ code: 10404 });
  }
  expect(await other.snapshot()).toEqual(before);
  await expect(unrelated.access(unrelated.first)).resolves.toBeUndefined();
  await accepted(await s.put(body('unban', 0)));
  for (const pair of [sessions.first, sessions.second])
    expect(await sessions.refresh(pair)).toEqual({ code: 10404 });
});

it.each(['active', 'invalid', 'pending_auth', 'blocked', 'released', 'unbound'] as const)(
  '[AC-F1-07d#16] 封禁联动所有平台 %s，admin_disable 不覆盖',
  async (status) => {
    const s = await setup(h);
    const rows = [];
    for (const platform of ['taobao', 'pdd'])
      rows.push(
        await binding(s, {
          platform,
          status,
          blocked_reason: status === 'blocked' ? 'admin_disable' : null,
        }),
      );
    const before = await s.rows();
    await accepted(await s.put(body('ban')));
    for (const row of rows) {
      if (['active', 'invalid', 'pending_auth'].includes(status))
        expect(await current(s, row.id)).toMatchObject({
          status: 'blocked',
          blocked_reason: 'ban',
        });
      else expect(await current(s, row.id)).toEqual(before.find((item) => item.id === row.id));
    }
  },
);

it.each(['ban', 'admin_disable', 'deletion'] as const)(
  '[AC-F1-07d#17] 解封只恢复 ban 绑定，原因为 %s',
  async (blocked_reason) => {
    const s = await setup(h);
    await seedState(s, 'banned');
    const taobao = await binding(s, { status: 'blocked', blocked_reason });
    const pdd = await binding(s, { platform: 'pdd', status: 'blocked', blocked_reason });
    const sessions = await userSessions(s);
    const beforeSessions = await s.sessions();
    await accepted(await s.put(body('unban', 7)));
    for (const row of [taobao, pdd]) {
      if (blocked_reason === 'ban')
        expect(await current(s, row.id)).toMatchObject({
          status: row.platform === 'taobao' ? 'invalid' : 'active',
          blocked_reason: null,
        });
      else expect(await current(s, row.id)).toEqual(row);
    }
    expect(await s.sessions()).toEqual(beforeSessions);
    await expect(sessions.access(sessions.first)).resolves.toBeUndefined();
  },
);

it.each(['freeze', 'unfreeze'] as const)(
  '[AC-F1-07d#18] 契约：%s 不动会话与绑定',
  async (action) => {
    const s = await setup(h);
    if (action === 'unfreeze') await seedState(s, 'frozen');
    await binding(s);
    await binding(s, { platform: 'pdd', status: 'blocked', blocked_reason: 'admin_disable' });
    const sessions = await userSessions(s);
    const before = await s.snapshot();
    await accepted(await s.put(body(action, action === 'unfreeze' ? 7 : null)));
    expect(await s.rows()).toEqual(before.bindings);
    expect(await s.sessions()).toEqual(before.sessions);
    await expect(sessions.access(sessions.first)).resolves.toBeUndefined();
    expect((await sessions.refresh(sessions.second)).code).toBe(0);
  },
);
