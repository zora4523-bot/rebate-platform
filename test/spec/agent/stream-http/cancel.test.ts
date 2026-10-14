// B3-03d 第 9 节 6：POST /v1/agent/runs/{run_id}/cancel——①–③ 同发送消息；run 不存在或不在调用者的会话里
// 一律 30505（不区分，不调取消端口）；B3-03g 的 cancel() 返回 accepted → 200 EmptyResponse，随后尽力发
// Redis 信号（不等它；失败、抛错、挂起都仍是 200）；not_running → 30505 不发信号（BR-AI-23 细则「取消」）。
import { expect, it } from 'vitest';

import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import {
  FakeReply,
  expectOk,
  expectRefusal,
  guest,
  member,
  newId,
  ownerKeyOf,
  rig,
  type HttpRig,
  type Row,
} from './kit.ts';

/** Cancels and waits for the handler with a real-time bound; asserts it settled. */
async function cancel(r: HttpRig, caller: AgentCaller, runId: string): Promise<FakeReply> {
  const reply = new FakeReply();
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    r.http.cancelRun(caller, runId, reply).then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 5_000);
    }),
  ]);
  clearTimeout(timer);
  expect(settled, 'cancelRun settles without waiting for the signal').toBe(true);
  return reply;
}

function ownRun(r: HttpRig, caller: AgentCaller): string {
  return r.sessions.addRun(r.sessions.add(caller));
}

it('[AC-B3-03d#20] 取消：①→②→③ 按序，失败时不查 run 归属、不调取消端口、不发信号', async () => {
  const steps: { arrange: (r: HttpRig) => void; code: number; data?: Row }[] = [
    {
      arrange: (r) => {
        r.access.answer = { code: 30501 };
        r.identity.answer = { code: 10001 };
        r.consent.answer = { code: 10004 };
      },
      code: 30501,
    },
    { arrange: (r) => (r.identity.answer = { code: 10001 }), code: 10001 },
    { arrange: (r) => (r.identity.answer = { code: 10005 }), code: 10005 },
    {
      arrange: (r) => (r.consent.answer = { code: 10004 }),
      code: 10004,
      data: { consent_type: 'ai_third_party' },
    },
  ];
  for (const step of steps) {
    const r = rig();
    const caller = member();
    const runId = ownRun(r, caller);
    step.arrange(r);
    const reply = await cancel(r, caller, runId);
    await expectRefusal(reply, caller, 'cancel', step.code, step.data);
    expect(r.sessions.calls).toHaveLength(0);
    expect(r.cancel.calls).toHaveLength(0);
    expect(r.signals.calls).toHaveLength(0);
  }
});

it('[AC-B3-03d#21] run 不存在、属于别人的会话、属于同设备的游客会话（调用者已登录）：一律 30505，外壳相同，不调取消端口', async () => {
  const r = rig();
  const caller = member();
  const runs = [
    newId(),
    ownRun(r, member()),
    ownRun(r, guest()),
    r.sessions.addRun(r.sessions.addDeviceSession(caller)),
  ];
  const bodies: Row[] = [];
  for (const runId of runs) {
    const reply = await cancel(r, caller, runId);
    const call = await expectRefusal(reply, caller, 'cancel', 30505);
    const rest = { ...call.body };
    delete rest['trace_id'];
    bodies.push(rest);
  }
  expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  expect(r.cancel.calls).toHaveLength(0);
  expect(r.signals.calls).toHaveLength(0);
});

it('[AC-B3-03d#22] cancel() 返回 accepted → 200 EmptyResponse（data 为空对象），取消端口收到 {appId, runId}，随后发信号 (runId, ownerKey)', async () => {
  for (const caller of [member(), guest()]) {
    const r = rig();
    const runId = ownRun(r, caller);
    const reply = await cancel(r, caller, runId);
    expect(await expectOk(reply, caller, 'cancel')).toEqual({});
    expect(r.cancel.calls).toEqual([{ appId: caller.appId, runId }]);
    expect(r.signals.calls).toEqual([[runId, ownerKeyOf(caller)]]);
    expect(r.log.indexOf('cancel')).toBeLessThan(r.log.indexOf('signal'));
  }
});

it('[AC-B3-03d#23] Redis 信号失败（拒绝、同步抛错、永不返回）或没有信号端口：仍是 200，不抛未捕获异常', async () => {
  for (const mode of ['reject', 'throw', 'hang', 'absent'] as const) {
    const r = rig({ signals: mode !== 'absent' });
    if (mode !== 'absent') r.signals.mode = mode;
    const caller = guest();
    const runId = ownRun(r, caller);
    const reply = await cancel(r, caller, runId);
    expect(await expectOk(reply, caller, 'cancel'), mode).toEqual({});
    expect(r.cancel.calls).toHaveLength(1);
    // Let a rejected signal surface as an unhandled rejection if the layer dropped it unguarded.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});

it('[AC-B3-03d#24] cancel() 返回 not_running → 30505 不发信号；取消端口报错 → JSON 50001 不发信号', async () => {
  const r = rig();
  const caller = member();
  const runId = ownRun(r, caller);
  r.cancel.answer = 'not_running';
  await expectRefusal(await cancel(r, caller, runId), caller, 'cancel', 30505);
  expect(r.signals.calls).toHaveLength(0);

  const f = rig();
  const owner = guest();
  const failing = ownRun(f, owner);
  f.cancel.fail = true;
  const call = await expectRefusal(await cancel(f, owner, failing), owner, 'cancel', 50001);
  expect(JSON.stringify(call)).not.toContain('serialize');
  expect(f.signals.calls).toHaveLength(0);
});
