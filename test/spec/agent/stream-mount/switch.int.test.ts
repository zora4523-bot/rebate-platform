// B3-03f 第 9 节 5 与停机：
// - 关开关（BR-AI-12、BR-AI-13 进行中 run 10 秒内终止；followup 23 开关缓存 ≤5 s）：放行的输入检查 + 挂起的
//   tools 让 run 停在进行中；把 agent.enabled 改成 false 后推进注入的 Clock，run 在 ≤10 s 内以开关关闭结束
//   （error 30501、end_reason disabled、退还）；另一会话：改成 false 之后 5 s 发新消息 → 30501（读开关的缓存
//   ≤5 s，不是 content 默认的 60 s）。
// - 撤回同意：进行中的 run 在 ≤10 s 内以 10004 结束（consent_withdrawn，退还）。
// - runtime.close()：先不再受理（新消息不开新 run），再等进行中的 run 结束才 resolve；不关库。
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import {
  PassInputCheck,
  RecordingTools,
  consent,
  framesOf,
  message,
  newMember,
  openAgent,
  openSession,
  refusedCode,
  rig,
  runRow,
  runsOf,
  send,
  setConfig,
  settleWork,
  stepUntil,
  until,
  usePgEach,
  usedOf,
  type FakeReply,
} from './kit.ts';
import { sql } from 'kysely';

const pg = usePgEach(createTestDatabase);

/** Starts a message whose run stays in progress (held tools); resolves once its search began. */
async function heldRun(
  r: Awaited<ReturnType<typeof rig>>,
  tools: RecordingTools,
  caller: Awaited<ReturnType<typeof newMember>>,
  sessionId: string,
): Promise<{ handler: Promise<FakeReply>; settled: () => boolean }> {
  let settled = false;
  const handler = send(r, caller, sessionId, message('帮我找个保温杯'));
  void handler.then(
    () => (settled = true),
    () => (settled = true),
  );
  await until('the held keyword search started', () => tools.plans.length > 0);
  expect(settled, 'the run is in progress').toBe(false);
  return { handler, settled: () => settled };
}

it('[AC-B3-03f#8][BR-AI-12][BR-AI-13] 关开关：进行中的 run 在 agent.enabled 改为 false 后 ≤10 s 内以 30501 结束（end_reason disabled、退还）', async () => {
  const caller = await newMember(pg.db);
  await openAgent(pg.db);
  await consent(pg.db, caller);
  const tools = new RecordingTools().hold();
  const r = await rig(pg.db, { inputCheck: new PassInputCheck(), tools });
  const sessionId = await openSession(r, caller);
  const live = await heldRun(r, tools, caller, sessionId);

  await setConfig(pg.db, caller.appId, 'agent.enabled', false);
  const changedAt = r.time.t;
  expect(await stepUntil(r, pg.db, live.settled, changedAt + 10_000)).toBe(true);
  expect(r.time.t - changedAt).toBeLessThanOrEqual(10_000);

  const reply = await live.handler;
  const frames = framesOf(reply.chunks);
  const last = frames[frames.length - 1]!;
  expect(last.event).toBe('error');
  expect(last.data['code']).toBe(30501);
  const row = await runRow(pg.db, frames[0]!.data['run_id'] as string);
  expect(row).toMatchObject({ end_reason: 'disabled', settle_result: 'refunded' });
  expect(await usedOf(pg.db, caller.userId!)).toBe(0);
}, 120_000);

it('[AC-B3-03f#9][BR-AI-12] 开关缓存 ≤5 s：agent.enabled 改为 false 之后 5 s 新消息 → 30501，不建 run', async () => {
  const caller = await newMember(pg.db);
  await openAgent(pg.db);
  await consent(pg.db, caller);
  const r = await rig(pg.db, { inputCheck: new PassInputCheck() });
  // The session's checks read (and cache) agent.enabled = true now.
  const sessionId = await openSession(r, caller);
  await setConfig(pg.db, caller.appId, 'agent.enabled', false);
  await r.time.by(5_000);

  const reply = await send(r, caller, sessionId, message());
  expect(refusedCode(reply)).toBe(30501);
  expect(await runsOf(pg.db, sessionId)).toEqual([]);
}, 60_000);

it('[AC-B3-03f#10][BR-AI-13] 撤回同意：进行中的 run ≤10 s 内以 10004 结束（end_reason consent_withdrawn、退还）', async () => {
  const caller = await newMember(pg.db);
  await openAgent(pg.db);
  await consent(pg.db, caller);
  const tools = new RecordingTools().hold();
  const r = await rig(pg.db, { inputCheck: new PassInputCheck(), tools });
  const sessionId = await openSession(r, caller);
  const live = await heldRun(r, tools, caller, sessionId);

  await consent(pg.db, caller, { accepted: false });
  const changedAt = r.time.t;
  expect(await stepUntil(r, pg.db, live.settled, changedAt + 10_000)).toBe(true);
  const frames = framesOf((await live.handler).chunks);
  const last = frames[frames.length - 1]!;
  expect(last.event).toBe('error');
  expect(last.data['code']).toBe(10004);
  const row = await runRow(pg.db, frames[0]!.data['run_id'] as string);
  expect(row).toMatchObject({ end_reason: 'consent_withdrawn', settle_result: 'refunded' });
}, 120_000);

it('[AC-B3-03f#11][BR-AI-23] runtime.close()：先不再受理（新消息不开新 run），等进行中的 run 结束后才 resolve，不关库', async () => {
  const caller = await newMember(pg.db);
  const other = await newMember(pg.db);
  await openAgent(pg.db);
  await consent(pg.db, caller);
  await consent(pg.db, other);
  const tools = new RecordingTools().hold();
  const r = await rig(pg.db, { inputCheck: new PassInputCheck(), tools });
  const sessionId = await openSession(r, caller);
  const otherSession = await openSession(r, other);
  const live = await heldRun(r, tools, caller, sessionId);

  let closed = false;
  const closing = r.runtime.close().then(() => {
    closed = true;
  });
  await settleWork(pg.db);
  expect(closed, 'close waits for the run in progress').toBe(false);

  const refused = await send(r, other, otherSession, message());
  expect(refused.streams, 'no stream after close() started').toEqual([]);
  expect(refused.jsons).toHaveLength(1);
  expect(refused.jsons[0]!.body['code']).not.toBe(0);
  expect(await runsOf(pg.db, otherSession)).toEqual([]);

  // The held run ends by its time limit; close() resolves only after that.
  const limit = r.time.t + r.runtime.timings.runMaxMs + 30_000;
  expect(await stepUntil(r, pg.db, () => closed, limit, 1_000)).toBe(true);
  expect(live.settled()).toBe(true);
  await closing;
  const frames = framesOf((await live.handler).chunks);
  const row = await runRow(pg.db, frames[0]!.data['run_id'] as string);
  expect(row['final_event']).not.toBeNull();
  // The database is still usable: close() never closes it.
  await expect(sql`SELECT 1`.execute(pg.db)).resolves.toBeDefined();
}, 120_000);
