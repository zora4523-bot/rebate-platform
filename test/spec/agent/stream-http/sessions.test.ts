// B3-03d 第 9 节 7、8 的 HTTP 一侧：createAgentSession / getCurrentAgentSession 把会话存取端口的结果映射成
// 契约的 200 响应（AgentSessionResponse、AgentCurrentSessionResponse，时间为 RFC 3339 字符串）；所有者按
// BR-AI-20（登录用户 user_id，游客 device_id）交给存取端口；新会话 id 由服务端 ids() 生成。
import { expect, it } from 'vitest';

import { agentSessionDefaults } from '../../../../apps/api/src/modules/agent/store/index.ts';
import { FakeReply, IDLE_MS, START_MS, expectOk, guest, member, rig, type Row } from './kit.ts';

function instant(value: unknown): number {
  expect(value).toBeTypeOf('string');
  expect(value as string).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  );
  return Date.parse(value as string);
}

it('[AC-B3-03d#25] createAgentSession：所有者交给存取端口（登录用户 user，游客 device），新 id 来自 ids()，200 过契约 AgentSessionResponse', async () => {
  for (const caller of [member(), guest()]) {
    const r = rig();
    const reply = new FakeReply();
    await r.http.createSession(caller, reply);
    const data = await expectOk(reply, caller, 'create');
    const opens = r.sessions.calls.filter((c) => c.method === 'open');
    expect(opens).toHaveLength(1);
    expect(opens[0]!.owner).toEqual(
      caller.userId === null
        ? { kind: 'device', appId: caller.appId, deviceId: caller.deviceId }
        : {
            kind: 'user',
            appId: caller.appId,
            userId: caller.userId,
            deviceId: caller.deviceId,
          },
    );
    expect(r.ids).toContain(opens[0]!.arg);
    expect(data['session_id']).toBe(opens[0]!.arg);
    expect(instant(data['started_at'])).toBe(START_MS);
    expect(instant(data['last_active_at'])).toBe(START_MS);
    expect(r.admission.admits).toHaveLength(0);
  }
});

it('[AC-B3-03d#26] getCurrentAgentSession：有未过期会话时返回最近活跃的那个，没有时 data.session 为 null；两种都过契约 AgentCurrentSessionResponse', async () => {
  const r = rig();
  const caller = member();
  const none = new FakeReply();
  await r.http.currentSession(caller, none);
  expect(await expectOk(none, caller, 'current')).toEqual({ session: null });

  r.sessions.add(caller, { lastActiveMs: START_MS - 3_600_000 });
  const newest = r.sessions.add(caller, { lastActiveMs: START_MS - 60_000 });
  r.sessions.add(caller, { lastActiveMs: START_MS - 1_000, expired: true });
  // A guest session on the same device is not the user's (BR-AI-20).
  r.sessions.addDeviceSession(caller);
  const found = new FakeReply();
  await r.http.currentSession(caller, found);
  const data = await expectOk(found, caller, 'current');
  const session = data['session'] as Row;
  expect(session['session_id']).toBe(newest);
  expect(instant(session['last_active_at'])).toBe(START_MS - 60_000);
  expect(instant(session['started_at'])).toBe(START_MS - 120_000);
  const currents = r.sessions.calls.filter((c) => c.method === 'current');
  expect(currents.every((c) => c.owner.kind === 'user')).toBe(true);
});

it('[AC-B3-03d#33] 会话过期时长默认取 BR-AI-20 的 24 小时：agentSessionDefaults().idleMs', () => {
  expect(agentSessionDefaults().idleMs).toBe(IDLE_MS);
});
