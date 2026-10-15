// B3-03i 第 9 节 6、7（RunManager 部分）：G-1（规划 B3-05-plan §1.3）——同一个 RunManager 里的 run 各按
// 自己的主体取守卫（RunManagerDeps.guardFor，RunStart.appId）。BR-AI-13：撤回同意后该主体进行中的 run 在
// 10 秒内以 10004 终止，其他主体的 run 不受影响；BR-AI-12：agent.enabled=off 时进行中的 run 在 10 秒内以
// 30501 终止。兼容：不传 guardFor 时由共用的 guard 决定，与 B3-03b 相同（test/spec/agent/stream-run/** 不改，
// 其假注册表、假受理闸、手动时间照用）。帧与收尾的细节由 B3-03b 测试管，这里只看终止码、结局与主体隔离。
import { expect, it } from 'vitest';

import { createRunGuardFactory } from '../../../../apps/api/src/modules/agent/stream/access/index.ts';
import { shouldRefund } from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import {
  APP,
  CONFIG,
  FakeConsent,
  FakeVersion,
  GuardsByOwner,
  OTHER_APP,
  errorData,
  framesOf,
  isTerminal,
  multiRig,
  newId,
  openConfig,
  type Live,
  type MultiRig,
  type Step,
} from './kit.ts';

/** BR-AI-12 / BR-AI-13: a live run ends within 10 seconds of the switch or the withdrawal. */
const DEADLINE_MS = 10_000;

function lastFrame(run: Live): { event: string; data: Record<string, unknown> } {
  const frames = framesOf(run.sink.chunks);
  expect(frames.filter(isTerminal), 'exactly one terminal frame').toHaveLength(1);
  const last = frames[frames.length - 1]!;
  return { event: last.event, data: errorData(last.data) };
}

function refusal(code: 30501 | 10004) {
  return {
    event: 'error',
    data: { code, msg: `错误提示-${code}`, retryable: false, fallback: null },
  };
}

async function finishNormally(r: MultiRig, run: Live): Promise<void> {
  expect(run.settled(), 'still running before finish').toBe(false);
  expect(run.aborted(), 'not aborted').toBeUndefined();
  run.finish();
  expect(await r.time.drive(run.promise, r.time.t + 5_000)).toBe(true);
  expect((await run.promise).ending).toBe('stop');
  expect(lastFrame(run)).toEqual({
    event: 'done',
    data: { finish_reason: 'stop', quota_left: 11 },
  });
}

it('[AC-B3-03i#23][BR-AI-13] G-1：两个并发 run（主体 A、B）各用 guardFor 取的守卫；A 的守卫答 10004 → A 一个轮询间隔内以 10004 结束，B 照常结束；guardFor 收到 {appId: RunStart.appId, ownerKey, runId}；共用 guard 不再被查询', async () => {
  const guards = new GuardsByOwner();
  const r = multiRig({ guardFor: guards.guardFor });
  const a = r.start(`u:${newId()}`, OTHER_APP);
  const b = r.start(`u:${newId()}`, OTHER_APP);
  await r.time.to(1_000);
  guards.of(a.ownerKey).answer = { code: 10004 };
  await r.time.to(1_000 + CONFIG.guardPollMs);
  expect(a.settled(), 'A ended').toBe(true);
  expect(a.aborted()).toBe('consent_withdrawn');
  expect((await a.promise).ending).toBe('consent_withdrawn');
  expect(lastFrame(a)).toEqual(refusal(10004));
  await finishNormally(r, b);
  expect(r.admission.calls.map((c) => [c.ticket.runId, c.outcome.ending])).toEqual(
    expect.arrayContaining([
      [a.ticket.runId, 'consent_withdrawn'],
      [b.ticket.runId, 'stop'],
    ]),
  );
  const expected = [
    { appId: OTHER_APP, ownerKey: a.ownerKey, runId: a.ticket.runId },
    { appId: OTHER_APP, ownerKey: b.ownerKey, runId: b.ticket.runId },
  ];
  expect(r.guardForCalls).toEqual(expect.arrayContaining(expected));
  for (const call of r.guardForCalls) expect(expected).toContainEqual(call);
  expect(r.guard.checks, 'the shared guard is not consulted').toBe(0);
});

it('[AC-B3-03i#24][BR-AI-13] G-1 端到端（createRunGuardFactory 作 guardFor）：用户 A 撤回同意 → A 的 run 10 秒内以 10004 结束；设备主体 B 的 run 照常结束；同意读取按各自主体查询', async () => {
  const version = new FakeVersion();
  const consent = new FakeConsent(version.source);
  const config = openConfig(APP);
  const r = multiRig({
    guardFor: createRunGuardFactory({ reader: config, consent, version: version.source }),
  });
  const userA = newId();
  const deviceB = newId();
  const a = r.start(`u:${userA}`, APP);
  const b = r.start(`d:${deviceB}`, APP);
  await r.time.to(1_000);
  expect([a.settled(), b.settled()]).toEqual([false, false]);
  consent.refuseUser(APP, userA, 'withdrawn');
  await r.time.to(1_000 + DEADLINE_MS);
  expect(a.settled(), 'A ended within 10 s').toBe(true);
  expect((await a.promise).ending).toBe('consent_withdrawn');
  expect(lastFrame(a)).toEqual(refusal(10004));
  await finishNormally(r, b);
  expect(consent.calls.some((s) => s.appId === APP && s.userId === userA)).toBe(true);
  expect(consent.calls).toContainEqual({ appId: APP, userId: null, deviceId: deviceB });
  expect(r.guard.checks).toBe(0);
});

it('[AC-B3-03i#25][BR-AI-12] G-1 端到端：agent.enabled 改为 off → 用户与设备主体的进行中 run 都在 10 秒内以 30501 结束（结局 disabled）', async () => {
  const version = new FakeVersion();
  const consent = new FakeConsent(version.source);
  const config = openConfig(APP);
  const r = multiRig({
    guardFor: createRunGuardFactory({ reader: config, consent, version: version.source }),
  });
  const a = r.start(`u:${newId()}`, APP);
  const b = r.start(`d:${newId()}`, APP);
  await r.time.to(2_000);
  expect([a.settled(), b.settled()]).toEqual([false, false]);
  config.set(APP, 'agent.enabled', false);
  await r.time.to(2_000 + DEADLINE_MS);
  for (const [name, run] of [
    ['A', a],
    ['B', b],
  ] as const) {
    expect(run.settled(), `${name} ended within 10 s`).toBe(true);
    expect((await run.promise).ending, name).toBe('disabled');
    expect(lastFrame(run), name).toEqual(refusal(30501));
  }
});

it('[AC-B3-03i#26][BR-AI-12][BR-AI-13] 只增不改：不传 guardFor（或 RunStart 不带 appId）时由共用 guard 决定，与 B3-03b 相同；传了 guardFor 且带 appId 时共用 guard 不再被查询', async () => {
  // Without guardFor: the shared guard says 10004 and both runs end, appId or not.
  const old = multiRig({});
  const o1 = old.start(`u:${newId()}`, APP);
  const o2 = old.start(`d:${newId()}`);
  await old.time.to(1_000);
  old.guard.answer = { code: 10004 };
  await old.time.to(1_000 + CONFIG.guardPollMs);
  for (const run of [o1, o2]) {
    expect(run.settled()).toBe(true);
    expect((await run.promise).ending).toBe('consent_withdrawn');
    expect(lastFrame(run)).toEqual(refusal(10004));
  }

  // guardFor given, but a run without appId: still the shared guard.
  const guards = new GuardsByOwner();
  const mixed = multiRig({ guardFor: guards.guardFor });
  const noApp = mixed.start(`u:${newId()}`);
  await mixed.time.to(1_000);
  mixed.guard.answer = { code: 30501 };
  await mixed.time.to(1_000 + CONFIG.guardPollMs);
  expect(noApp.settled(), 'a run without appId follows the shared guard').toBe(true);
  expect((await noApp.promise).ending).toBe('disabled');

  // guardFor given and appId present: the shared guard is ignored for that run.
  const fresh = multiRig({ guardFor: guards.guardFor });
  fresh.guard.answer = { code: 30501 };
  const withApp = fresh.start(`u:${newId()}`, APP);
  await fresh.time.to(3 * CONFIG.guardPollMs);
  expect(fresh.guard.checks, 'the shared guard is not consulted').toBe(0);
  await finishNormally(fresh, withApp);
});

it('[AC-B3-03i#32][BR-AI-12][BR-AI-13] G-1 跨应用：同一 RunManager、同一守卫工厂，应用 A、B 的 run 并发（同一 ownerKey）；A 关 agent.enabled → A 10 秒内以 30501 结束，B 正常结束；guardFor 每个 run 恰调用一次，收到各自的 appId 与 ownerKey', async () => {
  const version = new FakeVersion();
  const consent = new FakeConsent(version.source);
  const config = openConfig(APP)
    .set(OTHER_APP, 'agent.enabled', true)
    .set(OTHER_APP, 'agent.whitelist_only', false)
    .set(OTHER_APP, 'agent.whitelist_user_ids', []);
  const r = multiRig({
    guardFor: createRunGuardFactory({ reader: config, consent, version: version.source }),
  });
  const ownerKey = `u:${newId()}`;
  const a = r.start(ownerKey, APP);
  const b = r.start(ownerKey, OTHER_APP);
  await r.time.to(1_000);
  expect([a.settled(), b.settled()]).toEqual([false, false]);
  config.set(APP, 'agent.enabled', false);
  await r.time.to(1_000 + DEADLINE_MS);
  expect(a.settled(), 'A ended within 10 s').toBe(true);
  expect((await a.promise).ending).toBe('disabled');
  expect(lastFrame(a)).toEqual(refusal(30501));
  await finishNormally(r, b);
  expect(r.guardForCalls).toHaveLength(2);
  expect(r.guardForCalls).toEqual(
    expect.arrayContaining([
      { appId: APP, ownerKey, runId: a.ticket.runId },
      { appId: OTHER_APP, ownerKey, runId: b.ticket.runId },
    ]),
  );
  expect(r.guard.checks).toBe(0);
});

it('[AC-B3-03i#33][BR-AI-13] G-1 跨应用：同一用户在应用 A 撤回同意、在 B 仍同意 → 只有 A 的 run 10 秒内以 10004 结束，B 的 run 正常结束（守卫按各自 app 查同意）', async () => {
  const version = new FakeVersion();
  const consent = new FakeConsent(version.source);
  const config = openConfig(APP)
    .set(OTHER_APP, 'agent.enabled', true)
    .set(OTHER_APP, 'agent.whitelist_only', false);
  const r = multiRig({
    guardFor: createRunGuardFactory({ reader: config, consent, version: version.source }),
  });
  const userId = newId();
  const b = r.start(`u:${userId}`, OTHER_APP);
  const a = r.start(`u:${userId}`, APP);
  await r.time.to(1_000);
  consent.refuseUser(APP, userId, 'withdrawn');
  await r.time.to(1_000 + DEADLINE_MS);
  expect(a.settled(), 'A ended within 10 s').toBe(true);
  expect((await a.promise).ending).toBe('consent_withdrawn');
  expect(lastFrame(a)).toEqual(refusal(10004));
  await finishNormally(r, b);
  expect(consent.calls.some((s) => s.appId === OTHER_APP && s.userId === userId)).toBe(true);
  expect(r.guardForCalls).toHaveLength(2);
});

type Ending = { code: 30501 | 10004; ending: 'disabled' | 'consent_withdrawn'; refund: boolean };
/**
 * BR-AI-12: agent.enabled off ends a run with 30501 and a run without cards gets its quota back
 * (BR-AI-15; B3-03b ending 'disabled'); BR-AI-13: a withdrawal ends it with 10004 and returns no
 * quota (ending 'consent_withdrawn').
 */
const ENDINGS: Ending[] = [
  { code: 30501, ending: 'disabled', refund: true },
  { code: 10004, ending: 'consent_withdrawn', refund: false },
];

/**
 * One run ended by `c` without cards: through the shared guard (B3-03b) or through guardFor with
 * the real factory, next to a run of another subject that stays live. Returns the ended run's
 * steps and the rig.
 */
async function endOne(c: Ending, path: 'shared' | 'guardFor'): Promise<{ r: MultiRig; a: Live }> {
  const version = new FakeVersion();
  const consent = new FakeConsent(version.source);
  const config = openConfig(APP);
  const r =
    path === 'shared'
      ? multiRig({})
      : multiRig({
          guardFor: createRunGuardFactory({ reader: config, consent, version: version.source }),
        });
  const userA = newId();
  const a = r.start(`u:${userA}`, APP);
  const b = r.start(`d:${newId()}`, APP);
  await r.time.to(1_000);
  if (path === 'shared') r.guard.answer = { code: c.code };
  else if (c.code === 30501) config.set(APP, 'agent.enabled', false);
  else consent.refuseUser(APP, userA, 'withdrawn');
  // agent.enabled is per app: B (same app) may end too; only A's steps are compared.
  await r.time.to(1_000 + DEADLINE_MS);
  expect(a.settled(), `${path}: A ended within 10 s`).toBe(true);
  if (!b.settled()) {
    b.finish();
    expect(await r.time.drive(b.promise, r.time.t + 5_000)).toBe(true);
  }
  return { r, a };
}

it.each(ENDINGS)(
  '[AC-B3-03i#35][BR-AI-12][BR-AI-13][BR-AI-15] guardFor 路径以 $code 终止（未出卡）：admission.settle 对该 run 恰调用一次，RunOutcome = {$ending, 0}（退还 = $refund），与共用 guard 路径相同',
  async (c) => {
    const outcome = { ending: c.ending, cardsDelivered: 0 };
    for (const path of ['shared', 'guardFor'] as const) {
      const { r, a } = await endOne(c, path);
      const settles = r.steps(a.ticket.runId).filter((s) => s.kind === 'settle');
      expect(settles, `${path}: one settle`).toEqual([{ kind: 'settle', outcome }]);
      expect(
        r.admission.calls.filter((x) => x.ticket.runId === a.ticket.runId).map((x) => x.outcome),
        path,
      ).toEqual([outcome]);
      expect(shouldRefund(outcome), `${path}: refund per BR-AI-12 / BR-AI-13`).toBe(c.refund);
      const final = await a.promise;
      expect([final.ending, final.cardsDelivered], path).toEqual([c.ending, 0]);
    }
  },
);

it.each(ENDINGS)(
  '[AC-B3-03i#36][BR-AI-12][BR-AI-13][BR-AI-23] guardFor 路径以 $code 终止：终止原因先持久化（recordEnding 与带终态草稿的事实快照 {$ending, 0}），再 settle，再 finish 保存 error 终态；步骤与写入内容同共用 guard 路径逐项相同',
  async (c) => {
    const error = { code: c.code, msg: `错误提示-${c.code}`, retryable: false, fallback: null };
    const draft = { event: 'error' as const, data: error };
    const facts = { ending: c.ending, cardsDelivered: 0 };
    const expected: Step[] = [
      { kind: 'recordEnding', facts, draft },
      { kind: 'recordFacts', facts, draft },
      { kind: 'settle', outcome: facts },
      { kind: 'finish', terminal: draft },
    ];
    const seen: Record<string, Step[]> = {};
    for (const path of ['shared', 'guardFor'] as const) {
      const { r, a } = await endOne(c, path);
      const runId = a.ticket.runId;
      seen[path] = r.steps(runId);
      expect(seen[path], path).toEqual(expected);
      expect(await r.registry.facts(runId), `${path}: saved facts`).toEqual(facts);
      const saved = await r.registry.final(runId);
      expect(
        saved === null ? null : { event: saved.event, data: errorData({ ...saved.data }) },
        `${path}: saved terminal`,
      ).toEqual(draft);
    }
    expect(seen['guardFor']).toEqual(seen['shared']);
  },
);
