// B3-03h 第 9 节 1、2、3、4、6：受理后进程死亡的 run 由 worker 循环收尾（BR-AI-23 细则「受理记录与收尾 ·
// 谁来收尾」「崩溃不改变结果」，BR-AI-15 退还只发生一次；设计 couli-runs/B3-03g/design.md v5 §5.3、§7.4）。
// 真 PostgreSQL（每个用例一库：sweeper 读全库、advisory lock 按库）+ 真端口（createPgRunPorts）+ 真 HTTP
// 处理器（createAgentHttp）+ 真会话存取 + 真 worker 运行体（createAgentSweeperRuntime，即 AgentModule.forWorker
// 在 worker 上提供的那一个）+ 真循环；tick 只由注入的 schedule 触发，时间只走注入的 Clock，不等真实时间。
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { AgentCaller } from '../../../../apps/api/src/modules/agent/http/index.ts';
import { runTimingsDefaults } from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import { sweeperDefaults } from '../../../../apps/api/src/modules/agent/stream/sweeper/index.ts';
import { startAgentSweeper } from '../../../../apps/api/src/modules/agent/stream/sweeper/loop.ts';
import {
  createAgentSweeperRuntime,
  type AgentSweeperRuntime,
} from '../../../../apps/api/src/modules/agent/agent.module.ts';
import {
  APP,
  FakeReply,
  FakeSignals,
  GatedSweeper,
  LEVEL,
  Logs,
  ManualSchedule,
  START_MS,
  advisoryHolders,
  agentSnapshot,
  fileErrorMsg,
  framesOf,
  message,
  newMember,
  openSession,
  proc,
  retrace,
  runRow,
  runsOf,
  sendAndDie,
  sendLive,
  sessionRow,
  until,
  usePgEach,
  usedOf,
  type Proc,
  type Row,
} from './kit.ts';

const pg = usePgEach(createTestDatabase);

/** run_lock_expires_at − accepted_at (design §5.1). */
const LOCK_MS = runTimingsDefaults().runMaxMs + runTimingsDefaults().lockGraceMs;
/** The first instant a lock taken at START_MS is a left-over for the sweeper (+ 1 s). */
const SWEEP_MS = START_MS + LOCK_MS + sweeperDefaults().marginMs + 1_000;

interface Worker {
  readonly runtime: AgentSweeperRuntime;
  readonly clock: FixedClock;
  readonly logs: Logs;
  readonly schedule: ManualSchedule;
}

function worker(db: Kysely<DB>, atMs: number = SWEEP_MS): Worker {
  const clock = new FixedClock(new Date(atMs));
  const logs = new Logs();
  const runtime = createAgentSweeperRuntime({ db, clock, logger: logs.logger });
  return { runtime, clock, logs, schedule: new ManualSchedule() };
}

/** Starts the runtime's loop, fires exactly one tick, waits for its end, stops the loop. */
async function oneTick(w: Worker): Promise<Row> {
  const loop = w.runtime.start({ schedule: w.schedule.schedule });
  try {
    const before = w.logs.of('agent_sweep_tick').length;
    await w.schedule.fire('tick');
    const ticks = w.logs.of('agent_sweep_tick');
    expect(ticks, 'one agent_sweep_tick line for the tick').toHaveLength(before + 1);
    return ticks[ticks.length - 1]! as unknown as Row;
  } finally {
    await loop.stop();
  }
}

/** BR-AI-23 细则: no ending on the row → error 50001 (texts from the contract file). */
function recovered(): Row {
  return {
    type: 'error',
    data: { code: 50001, msg: fileErrorMsg(50001), retryable: true, fallback: null },
  };
}

async function crashed(
  p: Proc,
  caller: AgentCaller,
  options: { cancel?: boolean } = {},
): Promise<{ sessionId: string; runId: string; clientMsgId: string }> {
  const sessionId = await openSession(p, caller);
  const body = message();
  const { runId } = await sendAndDie(p, retrace(caller), sessionId, body);
  if (options.cancel === true) {
    const reply = new FakeReply();
    await p.http.cancelRun(retrace(caller), runId, reply);
    const call = reply.single();
    expect(call.status, 'cancel answered 200').toBe(200);
    expect(call.body['code']).toBe(0);
    expect((await runRow(pg.db, runId))['cancel_requested_at']).not.toBeNull();
  }
  // The process is dead: nothing ended or settled the run.
  const row = await runRow(pg.db, runId);
  expect(row['final_event']).toBeNull();
  expect(row['settle_result']).toBeNull();
  expect((await sessionRow(pg.db, sessionId))['run_lock_run_id']).toBe(runId);
  return { sessionId, runId, clientMsgId: body['client_msg_id'] as string };
}

it('[AC-B3-03h#1] 受理后进程死亡、无人重试：锁期 + 余量之后 worker 一轮 tick 把它收尾为 50001 / server_error，未出卡退还 1 条，会话锁与 advisory lock 都已释放；同键重放得到两帧（meta duplicate=true + 原终止帧），不起新 run', async () => {
  const caller = await newMember(pg.db);
  const a = proc(pg.db, START_MS);
  const left = await crashed(a, caller);
  expect(await usedOf(pg.db, caller.userId!)).toBe(1);

  const w = worker(pg.db);
  const tick = await oneTick(w);
  expect(tick).toMatchObject({ processed: 1, finalized: 1, failed: 0 });

  const row = await runRow(pg.db, left.runId);
  expect(row).toMatchObject({ end_reason: 'server_error', settle_result: 'refunded' });
  expect(row['final_event']).toEqual(recovered());
  expect(await usedOf(pg.db, caller.userId!)).toBe(0);
  expect((await sessionRow(pg.db, left.sessionId))['run_lock_run_id']).toBeNull();
  expect(await advisoryHolders(pg.db)).toEqual([]);

  // Same key again, on a live process after the recovery.
  const c = proc(pg.db, SWEEP_MS + 1_000);
  const replay = await sendLive(c, retrace(caller), left.sessionId, message(left.clientMsgId));
  expect(replay.jsons).toEqual([]);
  const frames = framesOf(replay.chunks);
  expect(frames.map((f) => [f.event, f.id])).toEqual([
    ['meta', 1],
    [(row['final_event'] as Row)['type'], 2],
  ]);
  expect(frames[0]!.data).toMatchObject({
    session_id: left.sessionId,
    run_id: left.runId,
    duplicate: true,
  });
  expect(frames[1]!.data).toEqual((row['final_event'] as Row)['data']);
  expect(await runsOf(pg.db, left.sessionId)).toHaveLength(1);
  expect(await usedOf(pg.db, caller.userId!)).toBe(0);
});

it('[AC-B3-03h#2] 崩溃后同会话来了新消息（未跑 sweeper）：受理事务先收尾遗留 run 再受理，新 run 正常结束、旧 run 已有终态且只退一次；之后一轮 tick 对该会话无事可做（零次收尾、表不变）', async () => {
  const caller = await newMember(pg.db);
  const a = proc(pg.db, START_MS);
  const left = await crashed(a, caller);

  const bMs = START_MS + LOCK_MS + 1_000;
  const b = proc(pg.db, bMs);
  const reply = await sendLive(b, retrace(caller), left.sessionId, message());
  expect(reply.jsons, 'accepted, not refused').toEqual([]);
  const frames = framesOf(reply.chunks);
  expect(frames[0]!.event).toBe('meta');
  expect(frames[frames.length - 1]).toMatchObject({
    event: 'done',
    data: { finish_reason: 'stop' },
  });

  const runs = await runsOf(pg.db, left.sessionId);
  expect(runs.map((r) => r['id'])).toEqual([left.runId, frames[0]!.data['run_id']]);
  const [old, fresh] = runs;
  expect(old).toMatchObject({ end_reason: 'server_error', settle_result: 'refunded' });
  expect(old!['final_event']).toEqual(recovered());
  expect((old!['settled_at'] as Date).getTime()).toBe(bMs);
  expect(fresh!['final_event']).not.toBeNull();
  expect(fresh!['settle_result']).not.toBe('refunded');
  expect(await usedOf(pg.db, caller.userId!)).toBe(1);
  expect((await sessionRow(pg.db, left.sessionId))['run_lock_run_id']).toBeNull();

  const before = await agentSnapshot(pg.db);
  const tick = await oneTick(worker(pg.db, bMs + LOCK_MS + sweeperDefaults().marginMs + 1_000));
  expect(tick).toMatchObject({ processed: 0, finalized: 0, failed: 0 });
  expect(await agentSnapshot(pg.db)).toBe(before);
  expect(await usedOf(pg.db, caller.userId!)).toBe(1);
});

it('[AC-B3-03h#3] 两个 worker（各自的连接池、同一库）同时 tick：一个持 advisory lock 处理时另一个记 locked 跳过、不调 sweepOnce；每条只收尾一次、只退一次（额度计数前后对比）', async () => {
  const a = proc(pg.db, START_MS);
  const members: AgentCaller[] = [];
  const left: { runId: string; sessionId: string }[] = [];
  for (let i = 0; i < 3; i += 1) {
    const caller = await newMember(pg.db);
    members.push(caller);
    left.push(await crashed(a, caller));
  }
  for (const m of members) expect(await usedOf(pg.db, m.userId!)).toBe(1);

  const poolB = pg.pool();
  const wa = worker(pg.db);
  const wb = worker(poolB);
  const ga = new GatedSweeper(wa.runtime.step);
  const gb = new GatedSweeper(wb.runtime.step);
  const la = startAgentSweeper({
    step: ga,
    db: pg.db,
    clock: wa.clock,
    logger: wa.logs.logger,
    config: wa.runtime.loopConfig,
    schedule: wa.schedule.schedule,
  });
  const lb = startAgentSweeper({
    step: gb,
    db: poolB,
    clock: wb.clock,
    logger: wb.logs.logger,
    config: wb.runtime.loopConfig,
    schedule: wb.schedule.schedule,
  });
  try {
    ga.close();
    const tickA = wa.schedule.fire('tick');
    await until('A started its pass under the lock', () => ga.calls === 1);
    expect(await advisoryHolders(pg.db)).toHaveLength(1);

    await wb.schedule.fire('tick');
    expect(gb.calls, 'B never ran a pass while A held the lock').toBe(0);
    expect(wb.logs.of('agent_sweep_skipped')).toEqual([
      expect.objectContaining({ reason: 'locked' }),
    ]);
    expect(wb.logs.of('agent_sweep_tick')).toEqual([]);

    ga.open();
    await tickA;
    expect(wa.logs.of('agent_sweep_tick')).toEqual([
      expect.objectContaining({ processed: 3, finalized: 3, failed: 0 }),
    ]);
    expect(await advisoryHolders(pg.db)).toEqual([]);

    // B's next tick takes the lock and finds nothing left.
    await wb.schedule.fire('tick');
    expect(gb.calls).toBe(1);
    expect(wb.logs.of('agent_sweep_tick')).toEqual([
      expect.objectContaining({ processed: 0, finalized: 0 }),
    ]);
  } finally {
    ga.open();
    await la.stop();
    await lb.stop();
  }
  for (const [i, run] of left.entries()) {
    expect(await runRow(pg.db, run.runId)).toMatchObject({
      end_reason: 'server_error',
      settle_result: 'refunded',
    });
    expect(await usedOf(pg.db, members[i]!.userId!)).toBe(0);
  }
});

it('[AC-B3-03h#4] 两个 worker 不加编排同时 tick：两边 tick 都正常结束（不记 failed），收尾合计恰为遗留数，每条只退一次', async () => {
  const a = proc(pg.db, START_MS);
  const members: AgentCaller[] = [];
  const left: { runId: string }[] = [];
  for (let i = 0; i < 4; i += 1) {
    const caller = await newMember(pg.db);
    members.push(caller);
    left.push(await crashed(a, caller));
  }
  const wa = worker(pg.db);
  const wb = worker(pg.pool());
  const la = wa.runtime.start({ schedule: wa.schedule.schedule });
  const lb = wb.runtime.start({ schedule: wb.schedule.schedule });
  try {
    await Promise.all([wa.schedule.fire('tick'), wb.schedule.fire('tick')]);
  } finally {
    await la.stop();
    await lb.stop();
  }
  const ticks = [...wa.logs.of('agent_sweep_tick'), ...wb.logs.of('agent_sweep_tick')];
  const skipped = [...wa.logs.of('agent_sweep_skipped'), ...wb.logs.of('agent_sweep_skipped')];
  expect(ticks.length + skipped.length).toBe(2);
  expect(ticks.length).toBeGreaterThanOrEqual(1);
  for (const t of ticks) expect(t).toMatchObject({ failed: 0 });
  expect(ticks.reduce((n, t) => n + (t['finalized'] as number), 0)).toBe(left.length);
  for (const [i, run] of left.entries()) {
    expect(await runRow(pg.db, run.runId)).toMatchObject({ settle_result: 'refunded' });
    expect(await usedOf(pg.db, members[i]!.userId!)).toBe(0);
  }
  expect(await advisoryHolders(pg.db)).toEqual([]);
});

it('[AC-B3-03h#5] 停 Redis：signals 缺省或替身全抛时，受理、取消（200）、活进程正常收尾、worker 收尾全部照常', async () => {
  for (const mode of ['absent', 'broken'] as const) {
    const signals = (): FakeSignals | 'absent' => {
      if (mode === 'absent') return 'absent';
      const s = new FakeSignals();
      s.broken = true;
      return s;
    };
    const a = proc(pg.db, START_MS, { signals: signals() });
    const plain = await newMember(pg.db);
    const cancelled = await newMember(pg.db);
    const live = await newMember(pg.db);
    const leftPlain = await crashed(a, plain);
    const leftCancelled = await crashed(a, cancelled, { cancel: true });

    const l = proc(pg.db, START_MS, { signals: signals() });
    const liveSession = await openSession(l, live);
    const reply = await sendLive(l, retrace(live), liveSession, message());
    const frames = framesOf(reply.chunks);
    expect(frames[frames.length - 1], mode).toMatchObject({
      event: 'done',
      data: { finish_reason: 'stop' },
    });
    expect((await sessionRow(pg.db, liveSession))['run_lock_run_id'], mode).toBeNull();

    const tick = await oneTick(worker(pg.db));
    expect(tick, mode).toMatchObject({ processed: 2, finalized: 2, failed: 0 });
    expect(await runRow(pg.db, leftPlain.runId), mode).toMatchObject({
      end_reason: 'server_error',
      settle_result: 'refunded',
    });
    expect(await runRow(pg.db, leftCancelled.runId), mode).toMatchObject({
      end_reason: 'cancelled',
    });
    expect(await usedOf(pg.db, plain.userId!), mode).toBe(0);
    expect(await usedOf(pg.db, cancelled.userId!), mode).toBe(1);
    expect(await usedOf(pg.db, live.userId!), mode).toBe(1);
  }
});

it('[AC-B3-03h#6] 取消返回 200（cancel 已写入 PG）后进程死亡：锁期 + 余量之后一轮 tick 收尾为 cancelled（done cancelled、照常计数、不退）', async () => {
  const caller = await newMember(pg.db);
  const a = proc(pg.db, START_MS);
  const left = await crashed(a, caller, { cancel: true });
  expect(await usedOf(pg.db, caller.userId!)).toBe(1);

  const tick = await oneTick(worker(pg.db));
  expect(tick).toMatchObject({ processed: 1, finalized: 1, failed: 0 });
  const row = await runRow(pg.db, left.runId);
  expect(row['end_reason']).toBe('cancelled');
  expect(row['settle_result']).not.toBeNull();
  expect(row['settle_result']).not.toBe('refunded');
  expect(row['final_event']).toEqual({
    type: 'done',
    data: { finish_reason: 'cancelled', quota_left: (await a.limits.current(APP)).memberDaily - 1 },
  });
  expect(await usedOf(pg.db, caller.userId!)).toBe(1);
  expect((await sessionRow(pg.db, left.sessionId))['run_lock_run_id']).toBeNull();
  expect(await advisoryHolders(pg.db)).toEqual([]);
});

it('[AC-B3-03h#7] worker 运行体的收尾文案来自契约文件：遗留 run 的 50001 终止帧 msg 等于 contracts/texts.default.json 的 error.50001（变量缺失时写法），不含占位符', async () => {
  const caller = await newMember(pg.db);
  const left = await crashed(proc(pg.db, START_MS), caller);
  const w = worker(pg.db);
  expect(w.runtime.texts.errorMsg(50001)).toBe(fileErrorMsg(50001));
  await oneTick(w);
  const data = ((await runRow(pg.db, left.runId))['final_event'] as Row)['data'] as Row;
  expect(data['msg']).toBe(fileErrorMsg(50001));
  expect(String(data['msg'])).not.toMatch(/\{[a-z_0-9]+\}/);
  expect(w.logs.all().filter((l) => l.level >= LEVEL.error)).toEqual([]);
});
