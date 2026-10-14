// B3-03d 第 9 节 2–4：⑥–⑩ 由 B3-03g 的 admission.admit 判定，本层只把 AdmissionResult 映射成 SSE 或
// JSON（04 §8.1「重复消息」、error-codes.yaml）；受理前错误 AdmissionUnavailableError → 50401、
// AdmissionHeldError → 50001、其他异常 → 50001 不泄露内部信息；admit 的入参：文本先脱敏、上限取自注入的
// QuotaLimitsSource、三个 id 由服务端生成且互不相同、计数主体按登录态与手机绑定组。
import { expect, it } from 'vitest';

import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import {
  AdmissionHeldError,
  AdmissionUnavailableError,
  type AdmissionResult,
  type OriginalRun,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import {
  LABELS,
  SOURCE_LIMITS,
  errorData,
  expectRefusal,
  expectStream,
  framesOf,
  guest,
  header,
  isTerminal,
  member,
  message,
  modelLabelOf,
  newId,
  redacted,
  rig,
  send,
  streamProblems,
  texts,
  type HttpRig,
} from './kit.ts';

function setup(caller: AgentCaller = guest()): {
  r: HttpRig;
  caller: AgentCaller;
  sessionId: string;
} {
  const r = rig();
  return { r, caller, sessionId: r.sessions.add(caller) };
}

function original(): OriginalRun {
  return {
    runId: newId(),
    userMessageId: newId(),
    assistantMessageId: newId(),
    promptVersion: 'agent-prompt@earlier-1',
    modelSnapshot: 'snap-earlier',
  };
}

it('[AC-B3-03d#8] accepted → 200 text/event-stream：首帧 meta（本 run 的 id、回复消息 id、标签，duplicate 为 false），随后是运行体的帧，终止帧恰一个且在最后', async () => {
  const { r, caller, sessionId } = setup();
  const reply = await send(r, caller, sessionId, message());
  expectStream(reply);
  const frames = framesOf(reply.chunks);
  expect(streamProblems(frames)).toEqual([]);
  expect(frames[0]!.event).toBe('meta');
  const req = r.admission.admits[0]!.req;
  expect(frames[0]!.data).toMatchObject({
    session_id: sessionId,
    run_id: req.runId,
    message_id: req.reply.assistantMessageId,
    prompt_version: LABELS.promptVersion,
    model_label: modelLabelOf(LABELS.modelSnapshot),
    ai_label: LABELS.aiLabel,
  });
  expect(frames[0]!.data['duplicate'] ?? false).toBe(false);
  expect(frames.map((f) => f.event)).toEqual(['meta', 'tool.status', 'text.delta', 'done']);
  expect(frames.filter(isTerminal)).toHaveLength(1);
  expect(r.starts).toHaveLength(1);
  expect(r.starts[0]!.ticket).toEqual(r.admission.tickets[0]);
  expect(reply.ended, 'the stream is ended once').toBe(1);
});

it('[AC-B3-03d#9] duplicate + final → 恰两帧：meta(duplicate=true，原 run 的 id 与 prompt_version，按原快照取展示名) 与原终止帧原样重放；不起新 run', async () => {
  const stored: { event: 'done' | 'error'; data: Record<string, unknown> }[] = [
    { event: 'done', data: { finish_reason: 'stop', quota_left: 4 } },
    { event: 'done', data: { finish_reason: 'cancelled', quota_left: 0 } },
    {
      event: 'error',
      data: { code: 50001, msg: texts.errorMsg(50001), retryable: true, fallback: null },
    },
  ];
  for (const frame of stored) {
    const { r, caller, sessionId } = setup(member());
    const orig = original();
    r.admission.answer = () =>
      ({
        kind: 'duplicate',
        original: orig,
        reply: { kind: 'final', frame },
      }) as unknown as AdmissionResult;
    const reply = await send(r, caller, sessionId, message());
    expectStream(reply);
    const frames = framesOf(reply.chunks);
    expect(streamProblems(frames)).toEqual([]);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual({
      event: 'meta',
      id: 1,
      data: {
        session_id: sessionId,
        run_id: orig.runId,
        message_id: orig.assistantMessageId,
        prompt_version: orig.promptVersion,
        model_label: modelLabelOf(orig.modelSnapshot),
        ai_label: LABELS.aiLabel,
        duplicate: true,
      },
    });
    expect({ event: frames[1]!.event, id: frames[1]!.id }).toEqual({ event: frame.event, id: 2 });
    expect(errorData(frames[1]!.data)).toEqual(errorData(frame.data));
    expect(r.starts).toHaveLength(0);
    expect(reply.ended).toBe(1);
  }
});

it('[AC-B3-03d#10] duplicate + running → meta(duplicate=true) 与 error 30506（retryable，fallback / fallback_q 为 null），不起新 run', async () => {
  const { r, caller, sessionId } = setup();
  const orig = original();
  r.admission.answer = () => ({ kind: 'duplicate', original: orig, reply: { kind: 'running' } });
  const reply = await send(r, caller, sessionId, message());
  expectStream(reply);
  const frames = framesOf(reply.chunks);
  expect(streamProblems(frames)).toEqual([]);
  expect(frames.map((f) => [f.event, f.id])).toEqual([
    ['meta', 1],
    ['error', 2],
  ]);
  expect(frames[0]!.data).toMatchObject({ run_id: orig.runId, duplicate: true });
  expect(frames[1]!.data).toEqual({
    code: 30506,
    msg: texts.errorMsg(30506),
    retryable: true,
    fallback: null,
    fallback_q: null,
  });
  expect(r.starts).toHaveLength(0);
});

it('[AC-B3-03d#11] rejected → JSON：30506 无 data；42901 带 Retry-After（秒，取自结果）；30504 round_limit 带 data.reason；30504 expired 与 ④ 相同不带 data；30502 带 reset_at 与 next', async () => {
  const cases: { result: AdmissionResult; data?: Record<string, unknown>; retryAfter?: string }[] =
    [
      { result: { kind: 'rejected', code: 30506 } },
      { result: { kind: 'rejected', code: 42901, retryAfterSeconds: 7 }, retryAfter: '7' },
      { result: { kind: 'rejected', code: 42901, retryAfterSeconds: 60 }, retryAfter: '60' },
      {
        result: { kind: 'rejected', code: 30504, reason: 'round_limit' },
        data: { reason: 'round_limit' },
      },
      { result: { kind: 'rejected', code: 30504, reason: 'expired' } },
      ...(['login', 'bind_phone', 'none'] as const).map((next) => ({
        result: {
          kind: 'rejected',
          code: 30502,
          resetAt: '2026-10-07T00:00:00+08:00',
          next,
        } as AdmissionResult,
        data: { reset_at: '2026-10-07T00:00:00+08:00', next },
      })),
    ];
  for (const c of cases) {
    const { r, caller, sessionId } = setup();
    r.admission.answer = () => c.result;
    const reply = await send(r, caller, sessionId, message());
    const code = (c.result as { code: number }).code;
    const call = await expectRefusal(reply, caller, 'send', code, c.data);
    expect(header(call.headers, 'retry-after'), `${code} Retry-After`).toBe(c.retryAfter);
    expect(r.starts).toHaveLength(0);
    expect(r.admission.admits).toHaveLength(1);
  }
});

it('[AC-B3-03d#12] 受理前错误：AdmissionUnavailableError(rolled_back / unknown) → JSON 50401；AdmissionHeldError → JSON 50001；其他异常 → JSON 50001，响应里没有异常的任何内容', async () => {
  const secret = 'pg 10.0.0.5:5432 password=hunter2 relation app.agent_runs';
  const cases: { error: unknown; code: number }[] = [
    { error: new AdmissionUnavailableError('rolled_back'), code: 50401 },
    { error: new AdmissionUnavailableError('unknown'), code: 50401 },
    { error: new AdmissionHeldError('held run 019a'), code: 50001 },
    { error: new Error(secret), code: 50001 },
    { error: new TypeError(secret), code: 50001 },
    { error: secret, code: 50001 },
  ];
  for (const c of cases) {
    const { r, caller, sessionId } = setup();
    r.admission.fail = c.error;
    const reply = await send(r, caller, sessionId, message());
    const call = await expectRefusal(reply, caller, 'send', c.code);
    const json = JSON.stringify(call);
    for (const leak of ['10.0.0.5', 'hunter2', 'agent_runs', 'held run']) {
      expect(json, `${c.code} leaks nothing`).not.toContain(leak);
    }
    expect(r.starts).toHaveLength(0);
  }
});

it('[AC-B3-03d#13] 上限来源读取失败 → JSON 50401 且不调 admit；脱敏或标签端口失败 → JSON 50001 且不调 admit', async () => {
  const arrange: [(r: HttpRig) => void, number][] = [
    [(r) => (r.limits.fail = true), 50401],
    [(r) => (r.redactor.fail = true), 50001],
    [(r) => (r.labels.fail = true), 50001],
  ];
  for (const [fail, code] of arrange) {
    const { r, caller, sessionId } = setup();
    fail(r);
    const reply = await send(r, caller, sessionId, message());
    await expectRefusal(reply, caller, 'send', code);
    expect(r.admission.admits).toHaveLength(0);
  }
});

it('[AC-B3-03d#14] admit 入参：文本先经脱敏端口（一次），runUserText 与 messageText 都是脱敏结果，原文不出现在入参里；上限是注入来源按 app 取到的值', async () => {
  const { r, caller, sessionId } = setup();
  const raw = '我的订单 4096123456 提现到 6222020200112233 了吗';
  const body = message(raw);
  await send(r, caller, sessionId, body);
  expect(r.redactor.calls).toEqual([{ appId: caller.appId, text: raw }]);
  expect(r.admission.admits).toHaveLength(1);
  const { req, limits } = r.admission.admits[0]!;
  expect(req.reply.runUserText).toBe(redacted(raw));
  expect(req.reply.messageText).toBe(redacted(raw));
  const serialized = JSON.stringify(r.admission.admits);
  expect(serialized).not.toContain(raw);
  expect(serialized).not.toContain('4096123456');
  expect(serialized).not.toContain('6222020200112233');
  expect(r.limits.calls).toEqual([caller.appId]);
  expect(limits).toEqual(SOURCE_LIMITS);
  expect(r.starts[0]!.limits).toEqual(SOURCE_LIMITS);
  expect(req.sessionId).toBe(sessionId);
  expect(req.clientMsgId).toBe(body['client_msg_id']);
  expect(req.reply.promptVersion).toBe(LABELS.promptVersion);
  expect(req.reply.modelSnapshot).toBe(LABELS.modelSnapshot);
  // The order: redaction and limits before admit.
  expect(r.log.indexOf('redact')).toBeLessThan(r.log.indexOf('admit'));
  expect(r.log.indexOf('limits')).toBeLessThan(r.log.indexOf('admit'));
});

it('[AC-B3-03d#15] runId、messageId、assistantMessageId 由服务端 ids() 生成、互不相同、每次请求都新；运行体与 RunStart 用同一组 id', async () => {
  const { r, caller, sessionId } = setup();
  await send(r, caller, sessionId, message('第一条'));
  await send(r, caller, sessionId, message('第二条'));
  expect(r.admission.admits).toHaveLength(2);
  const seen = new Set<string>();
  for (const [i, { req }] of r.admission.admits.entries()) {
    const ids = [req.runId, req.messageId, req.reply.assistantMessageId];
    expect(new Set(ids).size, 'three distinct ids').toBe(3);
    for (const id of ids) {
      expect(r.ids, 'generated by deps.ids()').toContain(id);
      expect(seen.has(id), 'never reused').toBe(false);
      seen.add(id);
    }
    expect(r.bodyInputs[i]).toMatchObject({
      sessionId,
      runId: req.runId,
      userMessageId: req.messageId,
      assistantMessageId: req.reply.assistantMessageId,
    });
    expect(r.starts[i]!.meta.message_id).toBe(req.reply.assistantMessageId);
  }
});

it('[AC-B3-03d#16] 计数主体：已绑手机的登录用户按 user_id；登录未绑手机与游客按 device_hash 与 IP 键（loggedIn 区分）；RunStart 的 ownerKey 是 u:<user_id> 或 d:<device_id>', async () => {
  const bound = member();
  const unbound = member({ phoneBound: false });
  const visitor = guest();
  const expected = [
    [bound, { tier: 'member', userId: bound.userId }, `u:${bound.userId!}`],
    [
      unbound,
      {
        tier: 'guest',
        loggedIn: true,
        deviceHash: unbound.deviceHash,
        ipKey: unbound.ipKey,
      },
      `u:${unbound.userId!}`,
    ],
    [
      visitor,
      { tier: 'guest', loggedIn: false, deviceHash: visitor.deviceHash, ipKey: visitor.ipKey },
      `d:${visitor.deviceId}`,
    ],
  ] as const;
  for (const [caller, subject, ownerKey] of expected) {
    const { r, sessionId } = setup(caller);
    await send(r, caller, sessionId, message());
    expect(r.admission.admits[0]!.req.subject).toEqual(subject);
    expect(r.starts[0]!.ownerKey).toBe(ownerKey);
  }
});
