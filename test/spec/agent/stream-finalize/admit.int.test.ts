// B3-03g: the admission transaction (design §2.1–2.5, §4.2 I3b I8 I9 I11 I14 I18, §7.2 同键交错 /
// 先收尾再受理 / 30506 零写入 / 活跃时间 / 提交结果未知 / 脱敏 / Redis 不可用; BR-AI-23 ⑥–⑩ in one
// PG transaction, 细则「受理结果不明」「谁来收尾」).
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  AdmissionHeldError,
  AdmissionUnavailableError,
  type AdmissionResult,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import {
  APP,
  MutableLimits,
  RECOVERED,
  START_MS,
  accepted,
  instance,
  limits,
  liveTail,
  member,
  memberKey,
  messagesOf,
  newSession,
  redact,
  request,
  runRow,
  runsOf,
  sessionRow,
  settled,
  snapshot,
  terminate,
  usedOn,
  usePg,
  waitingOnLock,
} from './kit.ts';

const pg = usePg(createTestDatabase);
const LOCK_END = START_MS + 50_000;
const at = (ms: number) => new FixedClock(new Date(ms));

it('[AC-B3-03g#29] 受理一次提交写下 run（accepted_at、quota_subjects、deadline_at、脱敏 user_text）、用户与回复两条消息和会话锁；回复行 text 为 NULL（I9、I18）', async () => {
  const a = instance(pg.db);
  const user = member();
  const session = await newSession(pg.db);
  const req = request(user, session, 'm-1', '我的手机号是13800138000，帮我找保温杯');
  expect(req.reply.runUserText).toBe(redact('我的手机号是13800138000，帮我找保温杯'));
  const { ticket, quotaLeft } = accepted(
    await a.ports.admission.admit(req, limits({ memberDaily: 3 })),
  );
  expect(quotaLeft).toBe(2);
  expect(ticket).toEqual({
    runId: req.runId,
    messageId: req.messageId,
    sessionId: session,
    subject: user,
    dayKey: '2026-10-06',
    acceptedAtMs: START_MS,
    lockExpiresAtMs: LOCK_END,
  });
  const run = await runRow(pg.db, req.runId);
  expect(run).toMatchObject({
    app_id: APP,
    session_id: session,
    prompt_version: 'agent-prompt@7',
    model_snapshot: 'qwen-plus-2026-09',
    quota_subjects: [memberKey(user)],
    end_reason: null,
    final_event: null,
    cancel_requested_at: null,
  });
  expect(run['accepted_at']).toEqual(new Date(START_MS));
  expect(run['deadline_at']).toEqual(new Date(START_MS + 20_000));
  expect(run['user_text']).toBe(req.reply.runUserText);
  expect(String(run['user_text'])).not.toContain('13800138000');
  const [userRow, replyRow] = await messagesOf(pg.db, req.runId);
  expect(userRow).toMatchObject({
    id: req.messageId,
    role: 'user',
    client_msg_id: 'm-1',
    text: req.reply.messageText,
  });
  expect(replyRow).toMatchObject({
    id: req.reply.assistantMessageId,
    role: 'assistant',
    client_msg_id: null,
    text: null,
  });
  expect(await sessionRow(pg.db, session)).toMatchObject({ run_lock_run_id: req.runId });
  expect((await sessionRow(pg.db, session))['last_active_at']).toEqual(new Date(START_MS));
});

it('[AC-B3-03g#30] 锁期内同键：duplicate running（04 §8.1 原 run 字段取自 PG），三张表逐行前后相同（I3b）；被拒与重复都不写 last_active_at', async () => {
  const a = instance(pg.db);
  const user = member();
  const session = await newSession(pg.db);
  const req = request(user, session, 'm-1');
  accepted(await a.ports.admission.admit(req, limits({ memberDaily: 1 })));
  // Every fixture row exists before the snapshot: only the requests under test run after it.
  const other = await newSession(pg.db);
  const before = await snapshot(pg.db);
  const b = instance(pg.db, { clock: at(START_MS + 30_000) });
  expect(
    await b.ports.admission.admit(request(user, session, 'm-1'), limits({ memberDaily: 1 })),
  ).toEqual({
    kind: 'duplicate',
    original: {
      runId: req.runId,
      userMessageId: req.messageId,
      assistantMessageId: req.reply.assistantMessageId,
      promptVersion: 'agent-prompt@7',
      modelSnapshot: 'qwen-plus-2026-09',
    },
    reply: { kind: 'running' },
  });
  expect(await b.ports.admission.admit(request(user, session, 'm-2'), limits())).toEqual({
    kind: 'rejected',
    code: 30506,
  });
  expect(
    await b.ports.admission.admit(request(user, other), limits({ memberDaily: 1 })),
  ).toMatchObject({ code: 30502 });
  expect(await snapshot(pg.db)).toBe(before);
});

it('[AC-B3-03g#31] 同键 B 停在受理事务开头时，A 受理并收尾、同会话下一条 N 已受理运行：B 继续后得 duplicate(final 原终态)，不是 30506（⑥ 先于 ⑦）', async () => {
  const user = member();
  const session = await newSession(pg.db);
  const a = instance(pg.db);
  const b = instance(pg.db);
  const original = request(user, session, 'm-same');
  let paused!: () => void;
  let go!: () => void;
  const reached = new Promise<void>((resolve) => (paused = resolve));
  const gate = new Promise<void>((resolve) => (go = resolve));
  b.hooks.onSql('admit', async () => {
    paused();
    await gate;
  });
  const { ticket } = accepted(await a.ports.admission.admit(original, limits()));
  const retry = b.ports.admission.admit(request(user, session, 'm-same'), limits());
  let tail;
  try {
    await reached;
    tail = await liveTail(a, ticket, 'stop', 1);
    accepted(await a.ports.admission.admit(request(user, session, 'm-next'), limits()));
  } finally {
    go();
  }
  expect(await retry).toEqual({
    kind: 'duplicate',
    original: {
      runId: original.runId,
      userMessageId: original.messageId,
      assistantMessageId: original.reply.assistantMessageId,
      promptVersion: original.reply.promptVersion,
      modelSnapshot: original.reply.modelSnapshot,
    },
    reply: { kind: 'final', frame: tail.sent },
  });
});

it('[AC-B3-03g#32] 先收尾再受理：锁过期的遗留 run + 新消息 → 一次提交里遗留 50001 退还并受理新消息，退还的额度当场可用（I11）', async () => {
  const quota = limits({ memberDaily: 1 });
  const a = instance(pg.db);
  const user = member();
  const session = await newSession(pg.db);
  const old = accepted(await a.ports.admission.admit(request(user, session), quota)).ticket;
  const b = instance(pg.db, { clock: at(LOCK_END), limits: new MutableLimits(quota) });
  const fresh = accepted(await b.ports.admission.admit(request(user, session), quota));
  expect(fresh.quotaLeft).toBe(0);
  const oldRow = await runRow(pg.db, old.runId);
  expect(oldRow).toMatchObject({ end_reason: 'server_error', settle_result: 'refunded' });
  expect(oldRow['final_event']).toEqual({ type: RECOVERED.event, data: RECOVERED.data });
  expect(await sessionRow(pg.db, session)).toMatchObject({ run_lock_run_id: fresh.ticket.runId });
  expect((await runsOf(pg.db, session)).map((r) => r['final_event'] === null)).toEqual([
    false,
    true,
  ]);
});

it('[AC-B3-03g#33] 遗留收尾遇可重试错误：受理整体回滚 → AdmissionUnavailableError(rolled_back)，遗留与新消息都没写', async () => {
  const a = instance(pg.db);
  const user = member();
  const session = await newSession(pg.db);
  accepted(await a.ports.admission.admit(request(user, session), limits()));
  const before = await snapshot(pg.db);
  const b = instance(pg.db, { clock: at(LOCK_END) });
  b.hooks.onCommit('admit', (pid) => terminate(pg.db, pid));
  const error = await settled(b.ports.admission.admit(request(user, session), limits()));
  expect(error).toBeInstanceOf(AdmissionUnavailableError);
  expect((error as AdmissionUnavailableError).outcome).toBe('rolled_back');
  expect(await snapshot(pg.db)).toBe(before);
});

it('[AC-B3-03g#34] 遗留 run 数据损坏：新消息 AdmissionHeldError，遗留标 hold、新消息不受理、计数不变', async () => {
  const a = instance(pg.db);
  const user = member();
  const session = await newSession(pg.db);
  const old = accepted(await a.ports.admission.admit(request(user, session), limits())).ticket;
  await sql`UPDATE app.agent_runs SET end_reason = 'stop', end_draft = ${JSON.stringify({ type: 'error', data: { code: 'x' } })}::jsonb
    WHERE app_id = ${APP} AND id = ${old.runId}`.execute(pg.db);
  const b = instance(pg.db, { clock: at(LOCK_END) });
  const next = request(user, session);
  await expect(b.ports.admission.admit(next, limits())).rejects.toBeInstanceOf(AdmissionHeldError);
  expect(await runRow(pg.db, old.runId)).toMatchObject({
    finalize_hold: 'stored_frame_invalid',
    final_event: null,
  });
  expect(await runsOf(pg.db, session)).toHaveLength(1);
  expect(await usedOn(pg.db, memberKey(user), '2026-10-06')).toBe(1);
});

it('[AC-B3-03g#35] 活跃时间：受理事务在主体锁上等待时钟走了 2 s，last_active_at 仍取拿到会话行锁后的 now；只增不减', async () => {
  const user = member();
  const s1 = await newSession(pg.db);
  const s2 = await newSession(pg.db);
  const a = instance(pg.db);
  const b = instance(pg.db, { clock: at(START_MS + 100) });
  const held = a.hooks.hold('admit');
  const first = a.ports.admission.admit(request(user, s1), limits());
  let pidB!: (n: number) => void;
  const bPid = new Promise<number>((resolve) => (pidB = resolve));
  let second!: Promise<AdmissionResult>;
  try {
    await held.reached;
    b.hooks.onSql('admit', (n) => {
      pidB(n);
      return Promise.resolve();
    });
    second = b.ports.admission.admit(request(user, s2), limits());
    await waitingOnLock(pg.db, await bPid);
    b.clock.set(new Date(START_MS + 2_100));
  } finally {
    held.release();
  }
  accepted(await first);
  accepted(await second);
  expect((await sessionRow(pg.db, s2))['last_active_at']).toEqual(new Date(START_MS + 100));
  expect((await runsOf(pg.db, s2))[0]!['accepted_at']).toEqual(new Date(START_MS + 100));
});

it('[AC-B3-03g#36] COMMIT 已生效、回包丢失：回查得已受理，返回 accepted 照常，PG 恰一条 run', async () => {
  const a = instance(pg.db);
  const user = member();
  const session = await newSession(pg.db);
  const req = request(user, session);
  a.hooks.onAfterCommit('admit', () => Promise.reject(new Error('reply lost')));
  const { ticket, quotaLeft } = accepted(
    await a.ports.admission.admit(req, limits({ memberDaily: 2 })),
  );
  expect(ticket.runId).toBe(req.runId);
  expect(quotaLeft).toBe(1);
  expect(await runsOf(pg.db, session)).toHaveLength(1);
});

it('[AC-B3-03g#37] 回包丢失且回查也失败：AdmissionUnavailableError(unknown)；同键重试锁期内 duplicate running，锁期后 50001 无卡退', async () => {
  const a = instance(pg.db);
  const user = member();
  const session = await newSession(pg.db);
  const req = request(user, session, 'm-u');
  a.hooks.onAfterCommit('admit', () => Promise.reject(new Error('reply lost')));
  a.hooks.onSql('lookup', () => Promise.reject(new Error('lookup connection refused')));
  const error = await settled(a.ports.admission.admit(req, limits()));
  expect(error).toBeInstanceOf(AdmissionUnavailableError);
  expect((error as AdmissionUnavailableError).outcome).toBe('unknown');
  const b = instance(pg.db, { clock: at(START_MS + 1_000) });
  expect(await b.ports.admission.admit(request(user, session, 'm-u'), limits())).toMatchObject({
    kind: 'duplicate',
    reply: { kind: 'running' },
  });
  b.clock.set(new Date(LOCK_END));
  expect(await b.ports.admission.admit(request(user, session, 'm-u'), limits())).toMatchObject({
    kind: 'duplicate',
    reply: { kind: 'final', frame: RECOVERED },
  });
  expect((await runRow(pg.db, req.runId))['settle_result']).toBe('refunded');
});

it('[AC-B3-03g#38] COMMIT 前连接被切断：回查无行 → AdmissionUnavailableError(rolled_back)，三张表不变', async () => {
  const a = instance(pg.db);
  const session = await newSession(pg.db);
  const before = await snapshot(pg.db);
  a.hooks.onCommit('admit', (pid) => terminate(pg.db, pid));
  const error = await settled(a.ports.admission.admit(request(member(), session), limits()));
  expect(error).toBeInstanceOf(AdmissionUnavailableError);
  expect((error as AdmissionUnavailableError).outcome).toBe('rolled_back');
  expect(await snapshot(pg.db)).toBe(before);
});

it('[AC-B3-03g#39] Redis 完全不可用（信号端口全抛）：受理、活进程收尾、恢复收尾照常', async () => {
  const a = instance(pg.db);
  a.signals.broken = true;
  const user = member();
  const session = await newSession(pg.db);
  const one = accepted(
    await a.ports.admission.admit(request(user, session), limits({ memberDaily: 5 })),
  );
  expect(await a.ports.registry.cancelRequested(one.ticket.runId)).toBe(false);
  const tail = await liveTail(a, one.ticket, 'stop', 1);
  expect(tail.quotaLeft).toBe(99);
  const two = accepted(
    await a.ports.admission.admit(request(user, session), limits({ memberDaily: 5 })),
  );
  const r = instance(pg.db, { clock: at(START_MS + 50_000) });
  r.signals.broken = true;
  expect(await r.ports.finalizer.finalize(two.ticket.runId)).toMatchObject({
    kind: 'final',
    frame: RECOVERED,
  });
});
