// B3-03g: crash points and the single finalization (design §3.1–3.5, §4.1 C2–C14a, §4.3 S4 vs
// F3 overlapping, §7.2 X-10, r4-3, r4 L2, 并发退还; BR-AI-23 细则「受理记录与收尾」, BR-AI-15 退还 /
// 归日 / quota_left, BR-AI-13; inherited B3-09b S1 BR-AI-23-lock-release-same-tx and
// BR-AI-15-derived-counting).
import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  AdmissionHeldError,
  AdmissionUnavailableError,
  type AdmissionRequest,
  type AdmissionResult,
  type AdmissionTicket,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import type { FinalizeOutcome } from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import {
  APP,
  MutableLimits,
  RECOVERED,
  START_MS,
  accepted,
  blockedBy,
  doneFrame,
  draftOf,
  guest,
  instance,
  limits,
  liveTail,
  lockRow,
  member,
  memberKey,
  newSession,
  nextPid,
  opaque,
  request,
  runRow,
  sessionRow,
  settled,
  stored,
  terminate,
  usedOn,
  usePg,
  waitingOnLock,
} from './kit.ts';

const pg = usePg();
const LOCK_END = START_MS + 50_000;
const at = (ms: number) => new FixedClock(new Date(ms));

async function acceptOne(quota = limits(), clockAt = START_MS) {
  const a = instance(pg.db, { clock: at(clockAt), limits: new MutableLimits(quota) });
  const user = member();
  const session = await newSession(pg.db, new Date(clockAt));
  const req = request(user, session);
  const { ticket, quotaLeft } = accepted(await a.ports.admission.admit(req, quota));
  return { a, user, session, req, ticket, quotaLeft };
}

it('[AC-B3-03g#13] 锁期 = 受理 + runMaxMs + 30 s；锁期内恢复方返回 running 不写、同会话新消息 30506；正好到期起按崩溃收尾为 50001 无卡退还，终态与释放锁同时可见', async () => {
  const { user, session, ticket, req } = await acceptOne();
  const s = await sessionRow(pg.db, session);
  expect(s['run_lock_run_id']).toBe(ticket.runId);
  expect(s['run_lock_expires_at']).toEqual(new Date(LOCK_END));
  expect(ticket.lockExpiresAtMs).toBe(LOCK_END);
  const r = instance(pg.db, { clock: at(LOCK_END - 1) });
  expect(await r.ports.finalizer.finalize(ticket.runId)).toEqual({ kind: 'running' });
  expect(await r.ports.admission.admit(request(user, session), limits())).toEqual({
    kind: 'rejected',
    code: 30506,
  });
  expect(
    await r.ports.admission.admit(request(user, session, req.clientMsgId), limits()),
  ).toMatchObject({
    kind: 'duplicate',
    reply: { kind: 'running' },
  });
  expect((await runRow(pg.db, ticket.runId))['final_event']).toBeNull();
  r.clock.set(new Date(LOCK_END));
  expect(await r.ports.finalizer.finalize(ticket.runId)).toEqual({
    kind: 'final',
    frame: RECOVERED,
    refunded: true,
    snapshotQuotaLeft: null,
    quotaLeft: 100,
    wrote: true,
  });
  const row = await runRow(pg.db, ticket.runId);
  expect(row).toMatchObject({
    end_reason: 'server_error',
    settle_result: 'refunded',
    card_delivered: false,
  });
  expect(row['final_event']).toEqual(stored(RECOVERED));
  expect(row['ended_at']).toEqual(new Date(LOCK_END));
  expect(row['accepted_at']).toEqual(new Date(START_MS));
  expect(await sessionRow(pg.db, session)).toMatchObject({
    run_lock_run_id: null,
    run_lock_expires_at: null,
  });
  expect(await usedOn(pg.db, memberKey(user), '2026-10-06')).toBe(0);
});

it('[AC-B3-03g#14] 结算、终态与释放锁同一事务：收尾事务停在提交前被切断 → 三者一起回滚（不会出现有终态而锁仍在），下一个发现者得同一结果', async () => {
  const { session, ticket } = await acceptOne();
  const r = instance(pg.db, { clock: at(LOCK_END) });
  const held = r.hooks.hold('finalize');
  const work = settled(r.ports.finalizer.finalize(ticket.runId));
  let pid: number;
  try {
    pid = await held.reached;
    const mid = await runRow(pg.db, ticket.runId);
    expect(mid['final_event']).toBeNull();
    expect((await sessionRow(pg.db, session))['run_lock_run_id']).toBe(ticket.runId);
    await terminate(pg.db, pid);
  } finally {
    held.release();
  }
  expect(await work).toBeInstanceOf(Error);
  const after = await runRow(pg.db, ticket.runId);
  expect(after).toMatchObject({ final_event: null, settle_result: null });
  expect((await sessionRow(pg.db, session))['run_lock_run_id']).toBe(ticket.runId);
  const next = instance(pg.db, { clock: at(LOCK_END + 1) });
  expect(await next.ports.finalizer.finalize(ticket.runId)).toMatchObject({
    kind: 'final',
    frame: RECOVERED,
    refunded: true,
  });
  const done = await runRow(pg.db, ticket.runId);
  expect(done['settled_at']).toEqual(done['ended_at']);
  expect((await sessionRow(pg.db, session))['run_lock_run_id']).toBeNull();
});

it('[AC-B3-03g#15] 卡帧写出后 S3 提交前崩溃按未下发（50001 退还）；S3 已提交按已下发（50001 不退）', async () => {
  for (const s3 of ['lost', 'committed'] as const) {
    const { a, user, ticket } = await acceptOne();
    if (s3 === 'lost') a.hooks.crashAt('facts', 'before');
    await settled(a.ports.registry.recordFacts(ticket.runId, { ending: null, cardsDelivered: 1 }));
    a.hooks.crashAt('ending', 'before');
    await settled(
      a.ports.registry.recordEnding(
        ticket.runId,
        { ending: 'stop', cardsDelivered: 1 },
        draftOf('stop'),
      ),
    );
    const r = instance(pg.db, { clock: at(LOCK_END) });
    const out = await r.ports.finalizer.finalize(ticket.runId);
    expect(out, s3).toMatchObject({ kind: 'final', frame: RECOVERED, refunded: s3 === 'lost' });
    expect((await runRow(pg.db, ticket.runId))['card_delivered'], s3).toBe(s3 === 'committed');
    expect(await usedOn(pg.db, memberKey(user), '2026-10-06'), s3).toBe(s3 === 'lost' ? 0 : 1);
  }
});

it('[AC-B3-03g#16] 以落库为准：撤回同意 / 关开关只在 S4 提交后算终止原因（10004 不退、30501 无卡退）；S4 未提交即崩溃一律 50001 无卡退还', async () => {
  const table = [
    [
      'consent_withdrawn',
      'committed',
      { end: 'consent_withdrawn', refunded: false, frame: draftOf('consent_withdrawn') },
    ],
    ['consent_withdrawn', 'lost', { end: 'server_error', refunded: true, frame: RECOVERED }],
    ['disabled', 'committed', { end: 'disabled', refunded: true, frame: draftOf('disabled') }],
    ['disabled', 'lost', { end: 'server_error', refunded: true, frame: RECOVERED }],
    [
      'server_error',
      'committed',
      { end: 'server_error', refunded: true, frame: draftOf('server_error') },
    ],
    ['timeout', 'lost', { end: 'server_error', refunded: true, frame: RECOVERED }],
  ] as const;
  for (const [ending, s4, expected] of table) {
    const label = `${ending}/${s4}`;
    const { a, ticket } = await acceptOne();
    a.hooks.crashAt(s4 === 'lost' ? 'ending' : 'settle', 'before');
    await settled(
      a.ports.registry.recordEnding(ticket.runId, { ending, cardsDelivered: 0 }, draftOf(ending)),
    );
    await settled(a.ports.admission.settle(ticket, { ending, cardsDelivered: 0 }, limits()));
    const r = instance(pg.db, { clock: at(LOCK_END + 10_000) });
    const out = await r.ports.finalizer.finalize(ticket.runId);
    expect(out, label).toMatchObject({
      kind: 'final',
      frame: expected.frame,
      refunded: expected.refunded,
    });
    const row = await runRow(pg.db, ticket.runId);
    expect(row['end_reason'], label).toBe(expected.end);
    expect(row['settle_result'], label).toBe(expected.refunded ? 'refunded' : 'counted');
  }
});

it('[AC-B3-03g#17] S5 提交前崩溃回到「有终止原因未结算」，锁期后按落库原因收尾；S5 提交后未发帧：同键即时重放原终态、同会话新消息即时受理', async () => {
  const one = await acceptOne();
  one.a.hooks.crashAt('settle', 'before');
  await one.a.ports.registry.recordEnding(
    one.ticket.runId,
    { ending: 'stop', cardsDelivered: 1 },
    draftOf('stop'),
  );
  expect(
    await settled(
      one.a.ports.admission.settle(one.ticket, { ending: 'stop', cardsDelivered: 1 }, limits()),
    ),
  ).toBeInstanceOf(Error);
  expect((await runRow(pg.db, one.ticket.runId))['settle_result']).toBeNull();
  const r = instance(pg.db, { clock: at(LOCK_END) });
  expect(await r.ports.finalizer.finalize(one.ticket.runId)).toMatchObject({
    kind: 'final',
    frame: doneFrame('stop', 99),
    refunded: false,
  });

  const two = await acceptOne();
  two.a.hooks.crashAt('settle', 'after');
  await two.a.ports.registry.recordEnding(
    two.ticket.runId,
    { ending: 'stop', cardsDelivered: 1 },
    draftOf('stop'),
  );
  await settled(
    two.a.ports.admission.settle(two.ticket, { ending: 'stop', cardsDelivered: 1 }, limits()),
  );
  const stored1 = (await runRow(pg.db, two.ticket.runId))['final_event'];
  expect(stored1).toEqual(stored(doneFrame('stop', 99)));
  const b = instance(pg.db, { clock: at(START_MS + 1_000) });
  expect(
    await b.ports.admission.admit(request(two.user, two.session, two.req.clientMsgId), limits()),
  ).toEqual({
    kind: 'duplicate',
    original: {
      runId: two.req.runId,
      userMessageId: two.req.messageId,
      assistantMessageId: two.req.reply.assistantMessageId,
      promptVersion: two.req.reply.promptVersion,
      modelSnapshot: two.req.reply.modelSnapshot,
    },
    reply: { kind: 'final', frame: doneFrame('stop', 99) },
  });
  expect((await b.ports.admission.admit(request(two.user, two.session), limits())).kind).toBe(
    'accepted',
  );
});

it('[AC-B3-03g#18] 跨午夜活进程：D 日 23:59:50 受理、次日 00:00:10 超时无卡 → 退 D 日，quota_left 为次日剩余', async () => {
  const quota = limits({ memberDaily: 2 });
  const lateMs = Date.parse('2026-10-06T23:59:50+08:00');
  const { a, user, ticket } = await acceptOne(quota, lateMs);
  const session2 = await newSession(pg.db, new Date(lateMs));
  a.clock.set('2026-10-07T00:00:05+08:00');
  accepted(await a.ports.admission.admit(request(user, session2), quota));
  a.clock.set('2026-10-07T00:00:10+08:00');
  const tail = await liveTail(a, ticket, 'timeout', 0);
  expect(tail).toMatchObject({ refunded: true, quotaLeft: 1 });
  expect(tail.sent).toEqual(doneFrame('timeout', 1));
  expect(ticket.dayKey).toBe('2026-10-06');
  expect(await usedOn(pg.db, memberKey(user), '2026-10-06')).toBe(0);
  expect(await usedOn(pg.db, memberKey(user), '2026-10-07')).toBe(1);
  expect((await runRow(pg.db, ticket.runId))['accepted_at']).toEqual(new Date(lateMs));
});

it('[AC-B3-03g#19] 跨午夜崩溃：00:00:40 起同键重试与同会话新消息各自收尾 → 50001 退 D 日，D+1 不变', async () => {
  const quota = limits({ memberDaily: 1 });
  const lateMs = Date.parse('2026-10-06T23:59:50+08:00');
  for (const finder of ['same-key', 'new-message'] as const) {
    const { user, session, req, ticket } = await acceptOne(quota, lateMs);
    const r = instance(pg.db, { clock: at(lateMs + 50_000), limits: new MutableLimits(quota) });
    const result =
      finder === 'same-key'
        ? await r.ports.admission.admit(request(user, session, req.clientMsgId), quota)
        : await r.ports.admission.admit(request(user, session), quota);
    if (finder === 'same-key') {
      expect(result).toMatchObject({
        kind: 'duplicate',
        reply: { kind: 'final', frame: RECOVERED },
      });
    } else {
      expect(accepted(result).quotaLeft).toBe(0);
    }
    expect((await runRow(pg.db, ticket.runId))['settle_result'], finder).toBe('refunded');
    expect(await usedOn(pg.db, memberKey(user), '2026-10-06'), finder).toBe(0);
    expect(await usedOn(pg.db, memberKey(user), '2026-10-07'), finder).toBe(
      finder === 'same-key' ? 0 : 1,
    );
  }
});

it('[AC-B3-03g#20] quota_left 按收尾时上限逐主体截断：上限 30→1 后收尾为 0（不是 28、不 hold），新消息 30502；上调到 50 后按 50', async () => {
  const quota = limits({ memberDaily: 30 });
  const { a, user, ticket } = await acceptOne(quota);
  const s2 = await newSession(pg.db);
  accepted(await a.ports.admission.admit(request(user, s2), quota));
  await a.ports.registry.recordEnding(
    ticket.runId,
    { ending: 'stop', cardsDelivered: 1 },
    draftOf('stop'),
  );
  a.limits.value = limits({ memberDaily: 1 });
  const lowered = await liveTail(a, ticket, 'stop', 1);
  expect(lowered).toMatchObject({ refunded: false, quotaLeft: 0 });
  expect(lowered.sent).toEqual(doneFrame('stop', 0));
  expect((await runRow(pg.db, ticket.runId))['finalize_hold']).toBeNull();
  const s3 = await newSession(pg.db);
  expect(
    await a.ports.admission.admit(request(user, s3), limits({ memberDaily: 1 })),
  ).toMatchObject({
    kind: 'rejected',
    code: 30502,
  });
  a.limits.value = limits({ memberDaily: 50 });
  expect(
    await a.ports.admission.settle(ticket, { ending: 'stop', cardsDelivered: 1 }, quota),
  ).toEqual({
    refunded: false,
    quotaLeft: 48,
  });
  expect((await runRow(pg.db, ticket.runId))['final_event']).toEqual(stored(doneFrame('stop', 0)));
});

it('[AC-B3-03g#21] 上限读取失败：活进程 settle 抛 AdmissionUnavailableError、不写；锁期后恢复方读到上限即收尾成功', async () => {
  const { a, ticket } = await acceptOne();
  await a.ports.registry.recordEnding(
    ticket.runId,
    { ending: 'stop', cardsDelivered: 0 },
    draftOf('stop'),
  );
  a.limits.fail = true;
  const before = await runRow(pg.db, ticket.runId);
  await expect(
    a.ports.admission.settle(ticket, { ending: 'stop', cardsDelivered: 0 }, limits()),
  ).rejects.toBeInstanceOf(AdmissionUnavailableError);
  const r0 = instance(pg.db, { clock: at(LOCK_END) });
  r0.limits.fail = true;
  await expect(r0.ports.finalizer.finalize(ticket.runId)).rejects.toBeInstanceOf(
    AdmissionUnavailableError,
  );
  expect(await runRow(pg.db, ticket.runId)).toEqual(before);
  const r = instance(pg.db, {
    clock: at(LOCK_END),
    limits: new MutableLimits(limits({ memberDaily: 7 })),
  });
  expect(await r.ports.finalizer.finalize(ticket.runId)).toMatchObject({
    kind: 'final',
    frame: doneFrame('stop', 6),
    refunded: false,
  });
});

it('[AC-B3-03g#22] 游客两主体各自截断后取小：device 已超新上限、IP 尚余 → quota_left 0；IP 较紧时取 IP 剩余', async () => {
  const ip = opaque('ik');
  const dh = opaque('dh');
  const quota = limits({ guestDaily: 3, guestIpDaily: 10 });
  const a = instance(pg.db, { limits: new MutableLimits(quota) });
  const tickets = [];
  for (let i = 0; i < 3; i += 1) {
    const s = await newSession(pg.db);
    tickets.push(accepted(await a.ports.admission.admit(request(guest(dh, ip), s), quota)).ticket);
  }
  a.limits.value = limits({ guestDaily: 1, guestIpDaily: 10 });
  expect((await liveTail(a, tickets[0]!, 'stop', 1)).quotaLeft).toBe(0);
  a.limits.value = limits({ guestDaily: 30, guestIpDaily: 4 });
  expect((await liveTail(a, tickets[1]!, 'stop', 1)).quotaLeft).toBe(1);
  expect((await liveTail(a, tickets[2]!, 'server_error', 0)).quotaLeft).toBe(2);
});

it('[AC-B3-03g#23] 两个恢复方同时收尾同一 run：只结算一次、只退一次，两边返回同一终态（一方 wrote=false）', async () => {
  const { user, ticket } = await acceptOne();
  const r1 = instance(pg.db, { clock: at(LOCK_END) });
  const r2 = instance(pg.db, { clock: at(LOCK_END + 3) });
  const [x, y] = await Promise.all([
    r1.ports.finalizer.finalize(ticket.runId),
    r2.ports.finalizer.finalize(ticket.runId),
  ]);
  expect([x, y].map((o) => (o.kind === 'final' ? o.wrote : null)).sort()).toEqual([false, true]);
  expect(x).toMatchObject({ kind: 'final', frame: RECOVERED, refunded: true });
  expect(y).toMatchObject({ kind: 'final', frame: RECOVERED, refunded: true });
  expect(await usedOn(pg.db, memberKey(user), '2026-10-06')).toBe(0);
});

it('[AC-B3-03g#24] 同一会员两会话各一条未退还 run（额度 30），两个恢复方同时无卡收尾：quota_left 一个 29、一个 30', async () => {
  const quota = limits({ memberDaily: 30 });
  const a = instance(pg.db, { limits: new MutableLimits(quota) });
  const user = member();
  const ids = [];
  for (let i = 0; i < 2; i += 1) {
    const s = await newSession(pg.db);
    ids.push(accepted(await a.ports.admission.admit(request(user, s), quota)).ticket.runId);
  }
  const r1 = instance(pg.db, { clock: at(LOCK_END), limits: new MutableLimits(quota) });
  const r2 = instance(pg.db, { clock: at(LOCK_END), limits: new MutableLimits(quota) });
  const out = await Promise.all([
    r1.ports.finalizer.finalize(ids[0]!),
    r2.ports.finalizer.finalize(ids[1]!),
  ]);
  expect(out.map((o) => (o.kind === 'final' ? o.quotaLeft : -1)).sort()).toEqual([29, 30]);
});

it('[AC-B3-03g#25] 坏 end_draft → finalize 返回 held(stored_frame_invalid) 并写 hold（不结算、不写终态）；之后该会话同键与新键都 AdmissionHeldError，计数不变，再 finalize 仍 held', async () => {
  const { user, session, req, ticket } = await acceptOne();
  await sql`UPDATE app.agent_runs SET end_reason = 'stop',
    end_draft = ${JSON.stringify({ type: 'done', data: { finish_reason: 42 } })}::jsonb
    WHERE app_id = ${APP} AND id = ${ticket.runId}`.execute(pg.db);
  const r = instance(pg.db, { clock: at(LOCK_END) });
  expect(await r.ports.finalizer.finalize(ticket.runId)).toEqual({
    kind: 'held',
    reason: 'stored_frame_invalid',
  });
  const row = await runRow(pg.db, ticket.runId);
  expect(row).toMatchObject({
    finalize_hold: 'stored_frame_invalid',
    final_event: null,
    settle_result: null,
  });
  expect(row['finalize_hold_at']).toEqual(new Date(LOCK_END));
  await expect(
    r.ports.admission.admit(request(user, session, req.clientMsgId), limits()),
  ).rejects.toBeInstanceOf(AdmissionHeldError);
  await expect(r.ports.admission.admit(request(user, session), limits())).rejects.toBeInstanceOf(
    AdmissionHeldError,
  );
  expect(await usedOn(pg.db, memberKey(user), '2026-10-06')).toBe(1);
  expect(await r.ports.finalizer.finalize(ticket.runId)).toEqual({
    kind: 'held',
    reason: 'stored_frame_invalid',
  });
});

it('[AC-B3-03g#26] 锁期内被标 hold：同键与新键立即 AdmissionHeldError、finalize 返回 held，不等锁期', async () => {
  const { user, session, req, ticket } = await acceptOne();
  await sql`UPDATE app.agent_runs SET finalize_hold = 'facts_inconsistent', finalize_hold_at = ${new Date(START_MS + 10)}
    WHERE app_id = ${APP} AND id = ${ticket.runId}`.execute(pg.db);
  const r = instance(pg.db, { clock: at(START_MS + 20) });
  await expect(
    r.ports.admission.admit(request(user, session, req.clientMsgId), limits()),
  ).rejects.toBeInstanceOf(AdmissionHeldError);
  await expect(r.ports.admission.admit(request(user, session), limits())).rejects.toBeInstanceOf(
    AdmissionHeldError,
  );
  expect(await r.ports.finalizer.finalize(ticket.runId)).toEqual({
    kind: 'held',
    reason: 'facts_inconsistent',
  });
});

it('[AC-B3-03g#27] 锁期后活进程 S4 与恢复方 F3 两种提交顺序：先提交者的终止原因胜，两边发出 / 重放的帧都等于 final_event', async () => {
  for (const first of ['live', 'recovery'] as const) {
    const { a, ticket } = await acceptOne();
    a.clock.set(new Date(LOCK_END + 1));
    const r = instance(pg.db, { clock: at(LOCK_END + 1) });
    let tail;
    if (first === 'live') {
      tail = await liveTail(a, ticket, 'stop', 1);
      expect(await r.ports.finalizer.finalize(ticket.runId), first).toMatchObject({
        kind: 'final',
        wrote: false,
      });
    } else {
      expect(await r.ports.finalizer.finalize(ticket.runId), first).toMatchObject({
        kind: 'final',
        wrote: true,
      });
      tail = await liveTail(a, ticket, 'stop', 1);
    }
    const row = await runRow(pg.db, ticket.runId);
    expect(row['end_reason'], first).toBe(first === 'live' ? 'stop' : 'server_error');
    expect(stored(tail.sent), first).toEqual(row['final_event']);
    expect(tail.refunded, first).toBe(first === 'recovery');
  }
});

it('[AC-B3-03g#28] 活进程 settle 与恢复方 finalize 并发（S4 已提交）：同一终态，结算一次；重入 finalize 返回 wrote=false 与当前剩余', async () => {
  const { a, ticket } = await acceptOne();
  await a.ports.registry.recordEnding(
    ticket.runId,
    { ending: 'timeout', cardsDelivered: 0 },
    draftOf('timeout'),
  );
  a.clock.set(new Date(LOCK_END));
  const r = instance(pg.db, { clock: at(LOCK_END) });
  const [s, f] = await Promise.all([
    a.ports.admission.settle(ticket, { ending: 'timeout', cardsDelivered: 0 }, limits()),
    r.ports.finalizer.finalize(ticket.runId),
  ]);
  expect(s).toEqual({ refunded: true, quotaLeft: 100 });
  expect(f).toMatchObject({ kind: 'final', frame: doneFrame('timeout', 100), refunded: true });
  expect(await a.ports.registry.finish(ticket.runId, doneFrame('timeout', 7))).toEqual(
    doneFrame('timeout', 100),
  );
  expect(await r.ports.finalizer.finalize(ticket.runId)).toEqual({
    kind: 'final',
    frame: doneFrame('timeout', 100),
    refunded: true,
    snapshotQuotaLeft: 100,
    quotaLeft: 100,
    wrote: false,
  });
});

type Racer = 'admission' | 'finalizer';
type Barrier = 'agent_sessions' | 'agent_runs';

/**
 * Lock order (design §2.2: session row → run row → subject locks, for the admission transaction
 * and the independent finalizeRun alike). A left-over run R (lock period over); the test holds
 * the `barrier` row lock, starts `first` and waits until it blocks on a lock, then starts the
 * other one and waits until it blocks too, then releases. Holding the session row with the
 * admission queued first makes an admission that holds the session wait for R while a finalizer
 * that took R first waits for the session; holding R with the finalizer queued first is the
 * mirror. A correct order never deadlocks (no 40P01, no AdmissionUnavailableError).
 */
async function raceLeftOver(
  barrier: Barrier,
  first: Racer,
  kind: 'same_key' | 'new_message',
): Promise<{
  label: string;
  user: ReturnType<typeof member>;
  session: string;
  req: AdmissionRequest;
  next: AdmissionRequest;
  ticket: AdmissionTicket;
  admission: AdmissionResult | Error;
  recovery: FinalizeOutcome | Error;
}> {
  const label = `${barrier}/${first}/${kind}`;
  const quota = limits({ memberDaily: 1 });
  const { user, session, req, ticket } = await acceptOne(quota);
  const admitter = instance(pg.db, { clock: at(LOCK_END), limits: new MutableLimits(quota) });
  const finalizer = instance(pg.db, { clock: at(LOCK_END), limits: new MutableLimits(quota) });
  const next =
    kind === 'same_key' ? request(user, session, req.clientMsgId) : request(user, session);
  const runs: {
    admission?: Promise<AdmissionResult | Error>;
    recovery?: Promise<FinalizeOutcome | Error>;
  } = {};
  const start = (who: Racer): Promise<number> => {
    if (who === 'admission') {
      const pid = nextPid(admitter.hooks, 'admit');
      runs.admission = settled(admitter.ports.admission.admit(next, quota));
      return pid;
    }
    const pid = nextPid(finalizer.hooks, 'finalize');
    runs.recovery = settled(finalizer.ports.finalizer.finalize(ticket.runId));
    return pid;
  };
  const release = await lockRow(
    pg.db,
    barrier,
    barrier === 'agent_sessions' ? session : ticket.runId,
  );
  try {
    for (const who of first === 'admission'
      ? (['admission', 'finalizer'] as const)
      : (['finalizer', 'admission'] as const)) {
      await waitingOnLock(pg.db, await start(who));
    }
  } finally {
    await release();
  }
  const admission = await runs.admission!;
  const recovery = await runs.recovery!;
  return { label, user, session, req, next, ticket, admission, recovery };
}

const RACES: [Barrier, Racer][] = [
  ['agent_sessions', 'admission'],
  ['agent_sessions', 'finalizer'],
  ['agent_runs', 'admission'],
  ['agent_runs', 'finalizer'],
];

it('[AC-B3-03g#86][BR-AI-23] 锁顺序：同键重试（受理事务内收尾遗留 run）与独立恢复方同时处理同一遗留 run，会话行 / run 行两种持锁交错 × 两种启动顺序都完成、不死锁；只结算一次，同键得 duplicate(final 原终态)，恢复方得同一终态', async () => {
  for (const [barrier, first] of RACES) {
    const { label, user, session, req, ticket, admission, recovery } = await raceLeftOver(
      barrier,
      first,
      'same_key',
    );
    expect(admission, label).toEqual({
      kind: 'duplicate',
      original: {
        runId: req.runId,
        userMessageId: req.messageId,
        assistantMessageId: req.reply.assistantMessageId,
        promptVersion: req.reply.promptVersion,
        modelSnapshot: req.reply.modelSnapshot,
      },
      reply: { kind: 'final', frame: RECOVERED },
    });
    expect(recovery, label).toMatchObject({ kind: 'final', frame: RECOVERED, refunded: true });
    const row = await runRow(pg.db, ticket.runId);
    expect(row, label).toMatchObject({ end_reason: 'server_error', settle_result: 'refunded' });
    expect(row['final_event'], label).toEqual(stored(RECOVERED));
    expect(await usedOn(pg.db, memberKey(user), '2026-10-06'), label).toBe(0);
    expect((await sessionRow(pg.db, session))['run_lock_run_id'], label).toBeNull();
  }
});

it('[AC-B3-03g#87][BR-AI-23] 锁顺序：同会话新消息（先收尾再受理）与独立恢复方同时处理同一遗留 run，两种持锁交错 × 两种启动顺序都完成、不死锁；遗留 50001 只退一次，新消息受理（quota_left 0）且锁归新 run', async () => {
  for (const [barrier, first] of RACES) {
    const { label, user, session, next, ticket, admission, recovery } = await raceLeftOver(
      barrier,
      first,
      'new_message',
    );
    expect(admission, label).toMatchObject({ kind: 'accepted', quotaLeft: 0 });
    expect(recovery, label).toMatchObject({ kind: 'final', frame: RECOVERED, refunded: true });
    const row = await runRow(pg.db, ticket.runId);
    expect(row, label).toMatchObject({ end_reason: 'server_error', settle_result: 'refunded' });
    expect(row['final_event'], label).toEqual(stored(RECOVERED));
    expect(await usedOn(pg.db, memberKey(user), '2026-10-06'), label).toBe(1);
    expect((await sessionRow(pg.db, session))['run_lock_run_id'], label).toBe(next.runId);
    expect((await runRow(pg.db, next.runId))['final_event'], label).toBeNull();
  }
});

it('[AC-B3-03g#88][BR-AI-23] 旧 run R 无终态、会话锁已指向另一 run N 且未过期（特制遗留）：R 不算运行中——恢复方与 R 的同键重试都按遗留收尾（50001 无卡退），N 的锁与锁期不变、N 不被收尾', async () => {
  for (const via of ['finalizer', 'same_key'] as const) {
    const { user, session, req, ticket } = await acceptOne();
    const other = randomUUID();
    const otherLockEnd = new Date(START_MS + 51_000);
    await sql`INSERT INTO app.agent_runs
      (id, app_id, session_id, prompt_version, accepted_at, quota_subjects, deadline_at)
      SELECT ${other}, app_id, session_id, prompt_version, ${new Date(START_MS + 1_000)},
        quota_subjects, ${new Date(START_MS + 21_000)}
      FROM app.agent_runs WHERE app_id = ${APP} AND id = ${ticket.runId}`.execute(pg.db);
    await sql`UPDATE app.agent_sessions SET run_lock_run_id = ${other},
      run_lock_expires_at = ${otherLockEnd} WHERE app_id = ${APP} AND id = ${session}`.execute(
      pg.db,
    );
    const r = instance(pg.db, { clock: at(START_MS + 5_000) });
    if (via === 'finalizer') {
      expect(await r.ports.finalizer.finalize(ticket.runId), via).toEqual({
        kind: 'final',
        frame: RECOVERED,
        refunded: true,
        snapshotQuotaLeft: null,
        quotaLeft: 99,
        wrote: true,
      });
    } else {
      expect(
        await r.ports.admission.admit(request(user, session, req.clientMsgId), limits()),
        via,
      ).toEqual({
        kind: 'duplicate',
        original: {
          runId: req.runId,
          userMessageId: req.messageId,
          assistantMessageId: req.reply.assistantMessageId,
          promptVersion: req.reply.promptVersion,
          modelSnapshot: req.reply.modelSnapshot,
        },
        reply: { kind: 'final', frame: RECOVERED },
      });
    }
    const row = await runRow(pg.db, ticket.runId);
    expect(row, via).toMatchObject({ end_reason: 'server_error', settle_result: 'refunded' });
    expect(row['final_event'], via).toEqual(stored(RECOVERED));
    expect(await sessionRow(pg.db, session), via).toMatchObject({
      run_lock_run_id: other,
      run_lock_expires_at: otherLockEnd,
    });
    expect(await runRow(pg.db, other), via).toMatchObject({
      end_reason: null,
      final_event: null,
      settle_result: null,
    });
    expect(await usedOn(pg.db, memberKey(user), '2026-10-06'), via).toBe(1);
  }
});

type Recovery = 'finalizer' | 'same_key';

/** Resolves with what `reached` gives, or fails when `work` ends first (it never got there). */
async function before<T>(reached: Promise<T>, work: Promise<unknown>, what: string): Promise<T> {
  const first = await Promise.race([
    reached.then((value) => ({ value })),
    work.then(() => 'ended' as const),
  ]);
  if (first === 'ended') throw new Error(`${what}: ended before getting there`);
  return first.value;
}

/**
 * S4 of a slow live process against the recovery of the same run after the lock period, truly
 * overlapping (design §4.3「活进程 S4 与恢复方 F3」, §3.3, §3.1 S4 RETURNING; Codex spec-test review
 * r2 S1-2). The live process chose consent_withdrawn (no card). `first` holds its transaction
 * before COMMIT with its write done, so it holds the run row lock: S4 its decision UPDATE, the
 * recovery (the independent finalizer, or the same-key retry finalizing R in the admission D path)
 * its whole finalization. While it is held the test checks from its own connection that the run
 * row still reads end_reason = NULL, starts the other side and waits until pg_blocking_pids shows
 * it blocked by the holder; the holder is released in `finally`. Then the live tail goes on as
 * RunManager does after S4: S4′ (recordFacts), S5 settle, S6 finish with its local frame.
 */
async function raceEnding(first: 'live' | 'recovery', via: Recovery) {
  const label = `${first}-first/${via}`;
  const { a, user, session, req, ticket } = await acceptOne();
  a.clock.set(new Date(START_MS + 10_000));
  const r = instance(pg.db, { clock: at(LOCK_END + 1) });
  const facts = { ending: 'consent_withdrawn', cardsDelivered: 0 } as const;
  const draft = draftOf('consent_withdrawn');
  const step = via === 'finalizer' ? 'finalize' : 'admit';
  const startS4 = () => settled(a.ports.registry.recordEnding(ticket.runId, facts, draft));
  const startRecovery = (): Promise<FinalizeOutcome | AdmissionResult | Error> =>
    via === 'finalizer'
      ? settled(r.ports.finalizer.finalize(ticket.runId))
      : settled(r.ports.admission.admit(request(user, session, req.clientMsgId), limits()));
  let s4: Promise<void | Error>;
  let recovery: Promise<FinalizeOutcome | AdmissionResult | Error>;
  if (first === 'live') {
    const held = a.hooks.hold('ending');
    s4 = startS4();
    try {
      const holder = await before(held.reached, s4, `${label}: S4 at its COMMIT`);
      expect(
        (await runRow(pg.db, ticket.runId))['end_reason'],
        `${label}: S4 written, not committed`,
      ).toBeNull();
      const pid = nextPid(r.hooks, step);
      recovery = startRecovery();
      await blockedBy(pg.db, await before(pid, recovery, `${label}: recovery SQL`), holder);
    } finally {
      held.release();
    }
  } else {
    const held = r.hooks.hold(step);
    recovery = startRecovery();
    try {
      const holder = await before(held.reached, recovery, `${label}: recovery at its COMMIT`);
      expect(
        (await runRow(pg.db, ticket.runId))['end_reason'],
        `${label}: recovery written, not committed`,
      ).toBeNull();
      const pid = nextPid(a.hooks, 'ending');
      s4 = startS4();
      await blockedBy(pg.db, await before(pid, s4, `${label}: S4 SQL`), holder);
    } finally {
      held.release();
    }
  }
  expect(await s4, `${label}: S4 resolves (0 rows is not an error)`).toBeUndefined();
  const recovered = await recovery;
  const factsAfterS4 = await a.ports.registry.facts(ticket.runId);
  a.clock.set(new Date(LOCK_END + 5_000));
  await a.ports.registry.recordFacts(ticket.runId, facts, draft);
  const settle = await a.ports.admission.settle(ticket, facts, limits());
  if (draft.event !== 'error') throw new Error('consent_withdrawn has an error draft');
  const sent = await a.ports.registry.finish(ticket.runId, draft);
  return { label, user, req, session, ticket, recovered, factsAfterS4, settle, sent };
}

const RECOVERIES: Recovery[] = ['finalizer', 'same_key'];

it('[AC-B3-03g#89][BR-AI-23][BR-AI-13][BR-AI-15] 活进程 S4（consent_withdrawn）已写入、停在提交前；锁期后恢复方（独立 finalizer / 同键重试）开始收尾时 run 行仍是 end_reason=null，并被 S4 挡在该 run 行锁上：S4 提交后恢复方读回 PG 依据按 10004 收尾、无卡不退，不写 server_error、不标 hold、无约束错误；只结算一次，两边发出的帧都等于 final_event', async () => {
  const consent = draftOf('consent_withdrawn');
  for (const via of RECOVERIES) {
    const { label, user, req, session, ticket, recovered, factsAfterS4, settle, sent } =
      await raceEnding('live', via);
    if (via === 'finalizer') {
      expect(recovered, label).toEqual({
        kind: 'final',
        frame: consent,
        refunded: false,
        snapshotQuotaLeft: null,
        quotaLeft: 99,
        wrote: true,
      });
    } else {
      expect(recovered, label).toEqual({
        kind: 'duplicate',
        original: {
          runId: req.runId,
          userMessageId: req.messageId,
          assistantMessageId: req.reply.assistantMessageId,
          promptVersion: req.reply.promptVersion,
          modelSnapshot: req.reply.modelSnapshot,
        },
        reply: { kind: 'final', frame: consent },
      });
    }
    expect(factsAfterS4, label).toEqual({ ending: 'consent_withdrawn', cardsDelivered: 0 });
    expect(settle, label).toEqual({ refunded: false, quotaLeft: 99 });
    expect(sent, label).toEqual(consent);
    const row = await runRow(pg.db, ticket.runId);
    expect(row, label).toMatchObject({
      end_reason: 'consent_withdrawn',
      card_delivered: false,
      settle_result: 'counted',
      finalize_hold: null,
      finalize_hold_at: null,
    });
    expect(row['end_draft'], label).toEqual(stored(consent));
    expect(row['final_event'], label).toEqual(stored(consent));
    expect(row['settled_at'], `${label}: settled once, by the recovery`).toEqual(
      new Date(LOCK_END + 1),
    );
    expect(row['ended_at'], label).toEqual(new Date(LOCK_END + 1));
    expect(await usedOn(pg.db, memberKey(user), '2026-10-06'), label).toBe(1);
    expect((await sessionRow(pg.db, session))['run_lock_run_id'], label).toBeNull();
  }
});

it('[AC-B3-03g#90][BR-AI-23][BR-AI-15] 反向：锁期后恢复方（独立 finalizer / 同键重试）已写 server_error 收尾、停在提交前；活进程 S4（consent_withdrawn）随后被挡在该 run 行锁上：恢复方提交后 S4 为 0 行、活进程读回 PG 值，按 50001 无卡退还一次，不改写为 10004、不标 hold，两边发出的帧都等于 final_event', async () => {
  for (const via of RECOVERIES) {
    const { label, user, req, session, ticket, recovered, factsAfterS4, settle, sent } =
      await raceEnding('recovery', via);
    if (via === 'finalizer') {
      expect(recovered, label).toEqual({
        kind: 'final',
        frame: RECOVERED,
        refunded: true,
        snapshotQuotaLeft: null,
        quotaLeft: 100,
        wrote: true,
      });
    } else {
      expect(recovered, label).toEqual({
        kind: 'duplicate',
        original: {
          runId: req.runId,
          userMessageId: req.messageId,
          assistantMessageId: req.reply.assistantMessageId,
          promptVersion: req.reply.promptVersion,
          modelSnapshot: req.reply.modelSnapshot,
        },
        reply: { kind: 'final', frame: RECOVERED },
      });
    }
    expect(factsAfterS4, label).toEqual({ ending: 'server_error', cardsDelivered: 0 });
    expect(settle, label).toEqual({ refunded: true, quotaLeft: 100 });
    expect(sent, label).toEqual(RECOVERED);
    const row = await runRow(pg.db, ticket.runId);
    expect(row, label).toMatchObject({
      end_reason: 'server_error',
      card_delivered: false,
      settle_result: 'refunded',
      finalize_hold: null,
      finalize_hold_at: null,
    });
    expect(row['end_draft'], label).toEqual(stored(RECOVERED));
    expect(row['final_event'], label).toEqual(stored(RECOVERED));
    expect(row['settled_at'], `${label}: settled once, by the recovery`).toEqual(
      new Date(LOCK_END + 1),
    );
    expect(await usedOn(pg.db, memberKey(user), '2026-10-06'), label).toBe(0);
    expect((await sessionRow(pg.db, session))['run_lock_run_id'], label).toBeNull();
  }
});
