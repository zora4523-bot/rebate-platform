// B3-03d 第 2 轮（Codex S1-2）：①②③ 与 ④、取消的归属检查都必须针对当前请求的主体。同一个 HTTP 实例上
// 交替处理两个不同主体（已绑手机的登录用户 A，另一个 app 的游客 B）的请求，门禁替身按主体给出不同结果；
// 断言每个端口收到的就是本次请求的完整身份（app_id、user_id、device_id、device_hash、ip 键、手机绑定、
// trace_id），而不是缓存的、上一个请求的主体。四个入口都覆盖。
import { expect, it } from 'vitest';

import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import {
  FakeReply,
  expectOk,
  expectRefusal,
  expectStream,
  guest,
  member,
  message,
  ownerKeyOf,
  ownerOf,
  request,
  rig,
  sameSubject,
  send,
  type Gate,
  type HttpRig,
  type Row,
} from './kit.ts';

const A = member();
const B: AgentCaller = { ...guest(), appId: 'brand-b' };

type GateName = 'access' | 'identity' | 'consent';
const GATES: GateName[] = ['access', 'identity', 'consent'];
const REFUSAL: Record<GateName, { code: number; data?: Row }> = {
  access: { code: 30501 },
  identity: { code: 10001 },
  consent: { code: 10004, data: { consent_type: 'ai_third_party' } },
};

function gate(r: HttpRig, name: GateName): Gate<number> {
  return r[name] as unknown as Gate<number>;
}

/** Makes `failing` refuse exactly the requests of `subject`; the other gates let all pass. */
function failFor(r: HttpRig, failing: GateName, subject: AgentCaller): void {
  gate(r, failing).decide = (c) =>
    sameSubject(c, subject) ? { code: REFUSAL[failing].code } : null;
}

/**
 * Each gate saw exactly the requests that reached it, each as the request's own caller: every
 * request reaches the gates up to the failing one; only the passing subject goes further.
 */
function expectGateCalls(
  r: HttpRig,
  failing: GateName,
  refused: AgentCaller,
  requests: AgentCaller[],
): void {
  for (const name of GATES) {
    const reached = requests.filter(
      (q) => !sameSubject(q, refused) || GATES.indexOf(name) <= GATES.indexOf(failing),
    );
    expect(gate(r, name).calls, `${failing} fails for one subject: ${name} saw`).toEqual(reached);
  }
}

it('[AC-B3-03d#36] 发消息：同一实例交替处理 A、B，①/②/③ 只拒 B；各门禁每次收到的都是本次请求的完整主体，④ 与 admit 也只见到当前主体', async () => {
  for (const failing of GATES) {
    const r = rig();
    const sA = r.sessions.add(A);
    const sB = r.sessions.add(B);
    failFor(r, failing, B);
    const requests = [request(A, 'a-1'), request(B, 'b-1'), request(A, 'a-2'), request(B, 'b-2')];
    for (const caller of requests) {
      const own = caller.userId === null ? sB : sA;
      const reply = await send(r, caller, own, message(), new FakeReply());
      if (sameSubject(caller, B)) {
        await expectRefusal(reply, caller, 'send', REFUSAL[failing].code, REFUSAL[failing].data);
      } else {
        expectStream(reply);
      }
    }
    expectGateCalls(r, failing, B, requests);
    const owned = r.sessions.calls.filter((c) => c.method === 'owned');
    expect(owned.map((c) => [c.owner, c.arg])).toEqual([
      [ownerOf(A), sA],
      [ownerOf(A), sA],
    ]);
    expect(r.admission.admits.map((a) => a.req.subject)).toEqual([
      { tier: 'member', userId: A.userId },
      { tier: 'member', userId: A.userId },
    ]);
    expect(r.limits.calls).toEqual([A.appId, A.appId]);
  }
});

it('[AC-B3-03d#37] 发消息 ④：同一实例交替 A、B 访问彼此的会话——存取端口每次收到当前主体的所有者，本人的会话受理、对方的会话 30504，受理的计数主体与 ownerKey 属于当前主体', async () => {
  const r = rig();
  const sA = r.sessions.add(A);
  const sB = r.sessions.add(B);
  const steps: [AgentCaller, string, boolean][] = [
    [request(A, 'a-1'), sA, true],
    [request(B, 'b-1'), sA, false],
    [request(B, 'b-2'), sB, true],
    [request(A, 'a-2'), sB, false],
  ];
  for (const [caller, sessionId, ok] of steps) {
    const reply = await send(r, caller, sessionId, message(), new FakeReply());
    if (ok) expectStream(reply);
    else await expectRefusal(reply, caller, 'send', 30504);
  }
  for (const name of GATES) {
    expect(gate(r, name).calls).toEqual(steps.map(([c]) => c));
  }
  expect(r.sessions.calls.filter((c) => c.method === 'owned').map((c) => [c.owner, c.arg])).toEqual(
    steps.map(([c, s]) => [ownerOf(c), s]),
  );
  expect(r.admission.admits.map((a) => [a.req.sessionId, a.req.subject])).toEqual([
    [sA, { tier: 'member', userId: A.userId }],
    [sB, { tier: 'guest', loggedIn: false, deviceHash: B.deviceHash, ipKey: B.ipKey }],
  ]);
  expect(r.limits.calls).toEqual([A.appId, B.appId]);
  expect(r.starts.map((s) => s.ownerKey)).toEqual([ownerKeyOf(A), ownerKeyOf(B)]);
});

it('[AC-B3-03d#38] 建会话、查当前会话：同一实例交替处理 B、A，①/②/③ 只拒 A；门禁收到本次请求的完整主体，存取端口只以当前通过者 B 的所有者被调用', async () => {
  for (const op of ['create', 'current'] as const) {
    for (const failing of GATES) {
      const r = rig();
      failFor(r, failing, A);
      const requests = [request(B, 'b-1'), request(A, 'a-1'), request(B, 'b-2'), request(A, 'a-2')];
      for (const caller of requests) {
        const reply = new FakeReply();
        if (op === 'create') await r.http.createSession(caller, reply);
        else await r.http.currentSession(caller, reply);
        if (sameSubject(caller, A)) {
          await expectRefusal(reply, caller, op, REFUSAL[failing].code, REFUSAL[failing].data);
        } else {
          await expectOk(reply, caller, op);
        }
      }
      expectGateCalls(r, failing, A, requests);
      expect(
        r.sessions.calls.map((c) => [c.method, c.owner]),
        `${op} ${failing}`,
      ).toEqual([
        [op === 'create' ? 'open' : 'current', ownerOf(B)],
        [op === 'create' ? 'open' : 'current', ownerOf(B)],
      ]);
    }
  }
});

it('[AC-B3-03d#39] 取消：同一实例交替处理 A、B——①/②/③ 只拒 B 时门禁收到本次请求的完整主体；归属检查、取消端口的 app_id 与信号的 ownerKey 每次都属于当前主体', async () => {
  for (const failing of GATES) {
    const r = rig();
    const runA = r.sessions.addRun(r.sessions.add(A));
    const runB = r.sessions.addRun(r.sessions.add(B));
    failFor(r, failing, B);
    const requests = [request(A, 'a-1'), request(B, 'b-1'), request(A, 'a-2'), request(B, 'b-2')];
    for (const caller of requests) {
      const reply = new FakeReply();
      await r.http.cancelRun(caller, sameSubject(caller, A) ? runA : runB, reply);
      if (sameSubject(caller, B)) {
        await expectRefusal(reply, caller, 'cancel', REFUSAL[failing].code, REFUSAL[failing].data);
      } else {
        expect(await expectOk(reply, caller, 'cancel')).toEqual({});
      }
    }
    expectGateCalls(r, failing, B, requests);
    expect(r.sessions.calls.map((c) => [c.owner, c.arg])).toEqual([
      [ownerOf(A), runA],
      [ownerOf(A), runA],
    ]);
  }

  // No gate refuses: ownership, the cancel port and the signal follow the current subject.
  const r = rig();
  const runA = r.sessions.addRun(r.sessions.add(A));
  const runB = r.sessions.addRun(r.sessions.add(B));
  const steps: [AgentCaller, string, boolean][] = [
    [request(A, 'a-1'), runA, true],
    [request(B, 'b-1'), runA, false],
    [request(B, 'b-2'), runB, true],
    [request(A, 'a-2'), runB, false],
  ];
  for (const [caller, runId, ok] of steps) {
    const reply = new FakeReply();
    await r.http.cancelRun(caller, runId, reply);
    if (ok) expect(await expectOk(reply, caller, 'cancel')).toEqual({});
    else await expectRefusal(reply, caller, 'cancel', 30505);
  }
  for (const name of GATES) {
    expect(gate(r, name).calls).toEqual(steps.map(([c]) => c));
  }
  expect(r.sessions.calls.map((c) => [c.owner, c.arg])).toEqual(
    steps.map(([c, run]) => [ownerOf(c), run]),
  );
  expect(r.cancel.calls).toEqual([
    { appId: A.appId, runId: runA },
    { appId: B.appId, runId: runB },
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(r.signals.calls).toEqual([
    [runA, ownerKeyOf(A)],
    [runB, ownerKeyOf(B)],
  ]);
});
