// B3-03d 第 9 节 1：BR-AI-23 ①–⑤ 在 HTTP 层按序判定，第一个失败的步骤决定返回；任何一步失败都不调用
// admission（也不脱敏、不取上限），返回 JSON 错误外壳。请求体格式错（类型、client_msg_id 格式、多余字段）
// 是 20001，先于 ①。④ 按 BR-AI-20：会话不存在、非本人、已过期一律 30504 不带 data；有登录态时只按
// user_id 判定，不回退到设备的游客会话。⑤ 按 Unicode 码点计。
import { expect, it } from 'vitest';

import {
  agentHttpDefaults,
  type AgentCaller,
} from '../../../../apps/api/src/modules/agent/http/index.ts';
import {
  FakeReply,
  TEXT_MAX,
  expectRefusal,
  guest,
  member,
  message,
  rig,
  send,
  type HttpRig,
  type Row,
} from './kit.ts';

const ASTRAL = '\u{20000}';

type Identity = 10001 | 10005 | null;
interface Combo {
  access: boolean;
  identity: Identity;
  consent: boolean;
  session: 'ok' | 'missing' | 'expired' | 'other';
  long: boolean;
}

/** BR-AI-23: the first failing step of ①–⑤ (computed here, not read from the output). */
function expected(c: Combo): { code: number; data?: Row } | null {
  if (c.access) return { code: 30501 };
  if (c.identity !== null) return { code: c.identity };
  if (c.consent) return { code: 10004, data: { consent_type: 'ai_third_party' } };
  if (c.session !== 'ok') return { code: 30504 };
  if (c.long) return { code: 20001, data: { fields: ['text'] } };
  return null;
}

function arrange(r: HttpRig, caller: AgentCaller, c: Combo): string {
  r.access.answer = c.access ? { code: 30501 } : null;
  r.identity.answer = c.identity === null ? null : { code: c.identity };
  r.consent.answer = c.consent ? { code: 10004 } : null;
  switch (c.session) {
    case 'ok':
      return r.sessions.add(caller);
    case 'expired':
      return r.sessions.add(caller, { expired: true });
    case 'other':
      return r.sessions.add(member());
    case 'missing':
      return '019a0000-0000-7000-8000-0000deadbeef';
  }
}

function combos(): Combo[] {
  const out: Combo[] = [];
  for (const access of [false, true])
    for (const identity of [null, 10001, 10005] as Identity[])
      for (const consent of [false, true])
        for (const session of ['ok', 'missing', 'expired', 'other'] as const)
          for (const long of [false, true]) out.push({ access, identity, consent, session, long });
  return out;
}

it('[AC-B3-03d#1] ①–⑤ 任意组合：返回第一个失败步骤的码与 JSON 外壳；被拒时不调 admit、不脱敏、不取上限，后续端口不被询问', async () => {
  for (const c of combos()) {
    const r = rig();
    const caller = member();
    const sessionId = arrange(r, caller, c);
    const text = c.long ? '字'.repeat(TEXT_MAX + 1) : '提现记录在哪看';
    const reply = await send(r, caller, sessionId, message(text));
    const want = expected(c);
    const label = JSON.stringify(c);
    if (want === null) {
      expect(r.admission.admits, label).toHaveLength(1);
      continue;
    }
    await expectRefusal(reply, caller, 'send', want.code, want.data);
    expect(r.admission.admits, `${label}: admit not called`).toHaveLength(0);
    expect(r.redactor.calls, `${label}: no redaction`).toHaveLength(0);
    expect(r.limits.calls, `${label}: no limits read`).toHaveLength(0);
    expect(r.starts, `${label}: no run`).toHaveLength(0);
    // Steps after the failing one are never asked.
    const asked = r.log.filter((e) =>
      ['access', 'identity', 'consent', 'sessions.owned'].includes(e),
    );
    const failedAt = c.access ? 1 : c.identity !== null ? 2 : c.consent ? 3 : 4;
    expect(asked, label).toEqual(
      ['access', 'identity', 'consent', 'sessions.owned'].slice(0, failedAt),
    );
  }
}, 60_000);

it('[AC-B3-03d#2] ④ BR-AI-20：别人的会话、不存在的会话、已过期的会话都是 30504 且不带 data，三者外壳完全相同', async () => {
  const bodies: Row[] = [];
  for (const kind of ['other', 'missing', 'expired'] as const) {
    const r = rig();
    const caller = guest();
    const sessionId = arrange(r, caller, {
      access: false,
      identity: null,
      consent: false,
      session: kind,
      long: false,
    });
    const reply = await send(r, caller, sessionId, message());
    const call = await expectRefusal(reply, caller, 'send', 30504);
    expect(r.admission.admits).toHaveLength(0);
    const rest = { ...call.body };
    delete rest['trace_id'];
    bodies.push(rest);
  }
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[2]).toEqual(bodies[0]);
});

it('[AC-B3-03d#3] ④ 有登录态时只按 user_id 判定：同一设备上的游客会话对登录用户是 30504，存取端口收到的所有者是 user 而不是 device', async () => {
  const r = rig();
  const caller = member();
  const guestSession = r.sessions.addDeviceSession(caller);
  const reply = await send(r, caller, guestSession, message());
  await expectRefusal(reply, caller, 'send', 30504);
  expect(r.admission.admits).toHaveLength(0);
  const owned = r.sessions.calls.filter((c) => c.method === 'owned');
  expect(owned).toHaveLength(1);
  expect(owned[0]!.owner).toMatchObject({
    kind: 'user',
    appId: caller.appId,
    userId: caller.userId,
  });

  // A guest is asked as its device.
  const g = rig();
  const visitor = guest();
  const own = g.sessions.add(visitor);
  await send(g, visitor, own, message());
  expect(g.sessions.calls.find((c) => c.method === 'owned')!.owner).toEqual({
    kind: 'device',
    appId: visitor.appId,
    deviceId: visitor.deviceId,
  });
  expect(g.admission.admits).toHaveLength(1);
});

it('[AC-B3-03d#4] ⑤ 文本长度按 Unicode 码点计：上限内（含四字节字符）进入受理，超过一个码点即 20001 data.fields=[text]', async () => {
  const cases: { text: string; ok: boolean }[] = [
    { text: 'a'.repeat(TEXT_MAX), ok: true },
    { text: '字'.repeat(TEXT_MAX), ok: true },
    // TEXT_MAX code points but 2 × TEXT_MAX UTF-16 units.
    { text: ASTRAL.repeat(TEXT_MAX), ok: true },
    { text: `${ASTRAL.repeat(TEXT_MAX - 1)}a`, ok: true },
    { text: 'a'.repeat(TEXT_MAX + 1), ok: false },
    { text: ASTRAL.repeat(TEXT_MAX + 1), ok: false },
    { text: `${'字'.repeat(TEXT_MAX)}${ASTRAL}`, ok: false },
  ];
  for (const { text, ok } of cases) {
    const r = rig();
    const caller = guest();
    const sessionId = r.sessions.add(caller);
    const reply = await send(r, caller, sessionId, message(text));
    if (ok) {
      expect(r.admission.admits, `${[...text].length} code points accepted`).toHaveLength(1);
    } else {
      await expectRefusal(reply, caller, 'send', 20001, { fields: ['text'] });
      expect(r.admission.admits).toHaveLength(0);
      expect(r.redactor.calls).toHaveLength(0);
    }
  }
});

it('[AC-B3-03d#5] ⑤ 的上限默认取 BR-AI-23 的值：agentHttpDefaults().textMaxCodePoints 等于 08 的上限', () => {
  expect(agentHttpDefaults().textMaxCodePoints).toBe(TEXT_MAX);
});

it('[AC-B3-03d#6] 请求体格式错是 20001（data.fields 指出字段），先于 ①：即使 ①–⑤ 全部会失败，也不询问任何端口', async () => {
  const valid = message();
  const cases: { body: unknown; fields: string[] }[] = [
    { body: { ...valid, client_msg_id: 'short' }, fields: ['client_msg_id'] },
    { body: { ...valid, client_msg_id: 'msg bad id!!' }, fields: ['client_msg_id'] },
    { body: { ...valid, client_msg_id: 'm'.repeat(65) }, fields: ['client_msg_id'] },
    { body: { ...valid, client_msg_id: 12345678 }, fields: ['client_msg_id'] },
    { body: { ...valid, text: 42 }, fields: ['text'] },
    { body: { ...valid, text: '' }, fields: ['text'] },
    { body: { client_msg_id: valid['client_msg_id'] }, fields: ['text'] },
    { body: { text: '你好' }, fields: ['client_msg_id'] },
    { body: { ...valid, session_id: 'x' }, fields: ['session_id'] },
    { body: null, fields: ['body'] },
    { body: '{"client_msg_id":"msg-00000001","text":"hi"}', fields: ['body'] },
  ];
  for (const { body, fields } of cases) {
    for (const failing of [false, true]) {
      const r = rig();
      const caller = guest();
      const sessionId = failing ? '019a0000-0000-7000-8000-0000deadbeef' : r.sessions.add(caller);
      if (failing) {
        r.access.answer = { code: 30501 };
        r.consent.answer = { code: 10004 };
      }
      const reply = await send(r, caller, sessionId, body, new FakeReply());
      await expectRefusal(reply, caller, 'send', 20001, { fields });
      expect(r.log, `${JSON.stringify(body)}: no port asked`).toEqual([]);
    }
  }
});

it('[AC-B3-03d#7] createAgentSession、getCurrentAgentSession 也按 ①→②→③ 判定（不碰会话存取），③ 带 consent_type=ai_third_party', async () => {
  const steps: { arrange: (r: HttpRig) => void; code: number; data?: Row; asked: string[] }[] = [
    {
      arrange: (r) => {
        r.access.answer = { code: 30501 };
        r.identity.answer = { code: 10001 };
        r.consent.answer = { code: 10004 };
      },
      code: 30501,
      asked: ['access'],
    },
    {
      arrange: (r) => {
        r.identity.answer = { code: 10005 };
        r.consent.answer = { code: 10004 };
      },
      code: 10005,
      asked: ['access', 'identity'],
    },
    {
      arrange: (r) => {
        r.identity.answer = { code: 10001 };
      },
      code: 10001,
      asked: ['access', 'identity'],
    },
    {
      arrange: (r) => {
        r.consent.answer = { code: 10004 };
      },
      code: 10004,
      data: { consent_type: 'ai_third_party' },
      asked: ['access', 'identity', 'consent'],
    },
  ];
  for (const op of ['create', 'current'] as const) {
    for (const step of steps) {
      const r = rig();
      const caller = guest();
      step.arrange(r);
      const reply = new FakeReply();
      if (op === 'create') await r.http.createSession(caller, reply);
      else await r.http.currentSession(caller, reply);
      await expectRefusal(reply, caller, op, step.code, step.data);
      expect(r.log, `${op} ${step.code}`).toEqual(step.asked);
      expect(r.sessions.sessions.size).toBe(0);
    }
  }
});
