// B3-03g fixture: one fresh PostgreSQL database per test file (createTestDatabase, business role
// couli_app only), service instances built on createPgRunPorts with their own FixedClock, hooks
// (crash points, barriers) and an in-memory limits source. No Redis: the optional cancel signal
// port is a fake. Ports are only built inside tests (never in hooks), so the NotImplemented of the
// skeleton reddens the test itself. Expected values stay in the rule tests.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type {
  AdmissionLimits,
  AdmissionRequest,
  AdmissionResult,
  AdmissionTicket,
  QuotaSubject,
  RedactedText,
  RunEnding,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import {
  createPgRunPorts,
  type CrashPoint,
  type PgRunPorts,
  type QuotaLimitsSource,
  type RunTimings,
  type TxHooks,
  type TxStep,
} from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import type {
  RunRegistry,
  TerminalDraft,
  TerminalFrame,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { connect, insertRow } from '../../db/linking-bindings/kit.ts';

export const APP = 'couli';
export const TIMINGS: RunTimings = { runMaxMs: 20_000, lockGraceMs: 30_000, cancelPgPollMs: 2_000 };
/** 2026-10-06T10:00:00+08:00. */
export const START = '2026-10-06T10:00:00+08:00';
export const START_MS = Date.parse(START);
export const texts = { errorMsg: (code: number) => `错误提示-${String(code)}` };

// ---- database ------------------------------------------------------------------------------

export interface Pg {
  readonly db: Kysely<DB>;
}

/** The one-shot database a test file creates (createTestDatabase from @couli/db/testing). */
export interface FixtureDatabase {
  urlFor(role: string): string;
  drop(): Promise<void>;
}

/**
 * Registers beforeAll / afterAll for one database of this file; `pg.db` inside tests. The
 * integration test passes createTestDatabase: only *.int.test.ts files may import
 * @couli/db/testing (.dependency-cruiser.cjs testcontainers-only-in-int-tests).
 */
export function usePg(createDatabase: () => Promise<FixtureDatabase>): Pg {
  let database: FixtureDatabase | undefined;
  let db: Kysely<DB> | undefined;
  beforeAll(async () => {
    database = await createDatabase();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 24 });
    connect(db);
  });
  afterAll(async () => {
    if (db) await destroyDb(db);
    if (database) await database.drop();
  });
  return {
    get db() {
      if (db === undefined) throw new Error('database not ready');
      return db;
    },
  };
}

/** A device-owned session started 1 s before `at` (ownership is B3-03d's, not judged here). */
export async function newSession(db: Kysely<DB>, at: Date | string = START): Promise<string> {
  connect(db);
  const when = new Date(new Date(at).getTime() - 1_000);
  const deviceId = randomUUID();
  await insertRow('devices', {
    id: deviceId,
    app_id: APP,
    user_id: null,
    install_secret_cipher: Buffer.from('synthetic-install-secret'),
    last_seen_at: when,
  });
  const id = randomUUID();
  await sql`INSERT INTO app.agent_sessions (id, app_id, device_id, started_at, last_active_at)
    VALUES (${id}, ${APP}, ${deviceId}, ${when}, ${when})`.execute(db);
  return id;
}

export type Row = Record<string, unknown>;

export async function runRow(db: Kysely<DB>, runId: string): Promise<Row> {
  const r = await sql<Row>`SELECT * FROM app.agent_runs WHERE id = ${runId}`.execute(db);
  expect(r.rows, `agent_runs ${runId}`).toHaveLength(1);
  return r.rows[0]!;
}

export async function sessionRow(db: Kysely<DB>, sessionId: string): Promise<Row> {
  const r = await sql<Row>`SELECT * FROM app.agent_sessions WHERE id = ${sessionId}`.execute(db);
  expect(r.rows, `agent_sessions ${sessionId}`).toHaveLength(1);
  return r.rows[0]!;
}

export async function messagesOf(db: Kysely<DB>, runId: string): Promise<Row[]> {
  const r = await sql<Row>`SELECT * FROM app.agent_messages WHERE run_id = ${runId}
    ORDER BY role DESC`.execute(db);
  return r.rows;
}

export async function runsOf(db: Kysely<DB>, sessionId: string): Promise<Row[]> {
  const r = await sql<Row>`SELECT * FROM app.agent_runs WHERE session_id = ${sessionId}
    ORDER BY accepted_at, id`.execute(db);
  return r.rows;
}

/** Every row of the three admission tables, as text: equal snapshots = nothing was written. */
export async function snapshot(db: Kysely<DB>): Promise<string> {
  const parts: string[] = [];
  for (const table of ['agent_sessions', 'agent_runs', 'agent_messages']) {
    const r = await sql<{ j: unknown }>`SELECT to_jsonb(t) AS j FROM ${sql.table(`app.${table}`)} t
      ORDER BY id`.execute(db);
    parts.push(JSON.stringify(r.rows.map((row) => row.j)));
  }
  return parts.join('\n');
}

/** Waits (bounded polling, no fixed sleep) until backend `pid` waits on a lock. */
export async function waitingOnLock(db: Kysely<DB>, pid: number): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    const r = await sql<{ w: string | null }>`SELECT wait_event_type AS w FROM pg_stat_activity
      WHERE pid = ${pid}`.execute(db);
    if (r.rows[0]?.w === 'Lock') return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect.fail(`backend ${String(pid)} never waited on a lock`);
}

/**
 * Waits (bounded polling, no fixed sleep) until backend `pid` is blocked by backend `blocker`
 * (`pg_blocking_pids`): the waiter queues behind that very transaction, not just on some lock.
 */
export async function blockedBy(db: Kysely<DB>, pid: number, blocker: number): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    const r = await sql<{ b: boolean }>`SELECT ${blocker}::int = ANY(pg_blocking_pids(${pid}::int))
      AS b`.execute(db);
    if (r.rows[0]?.b === true) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect.fail(`backend ${String(pid)} was never blocked by backend ${String(blocker)}`);
}

/**
 * A test-held row lock (barrier): `SELECT … FOR UPDATE` on one row of agent_sessions or agent_runs
 * in the test's own transaction. Resolves once the lock is held; the returned function commits it
 * (releasing the lock) and waits for that commit.
 */
export async function lockRow(
  db: Kysely<DB>,
  table: 'agent_sessions' | 'agent_runs',
  id: string,
): Promise<() => Promise<void>> {
  let locked!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (locked = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const tx = db.transaction().execute(async (trx) => {
    const r = await sql`SELECT id FROM ${sql.table(`app.${table}`)} WHERE id = ${id}
      FOR UPDATE`.execute(trx);
    expect(r.rows, `${table} ${id}`).toHaveLength(1);
    locked();
    await gate;
  });
  const ended = tx.then(
    () => 'ended' as const,
    () => 'ended' as const,
  );
  if ((await Promise.race([ready.then(() => 'locked' as const), ended])) !== 'locked') {
    await tx;
    expect.fail(`lock on ${table} ${id} was never held`);
  }
  return async () => {
    release();
    await tx;
  };
}

/** The backend pid of the next SQL statement `hooks` runs for `step` (register before starting). */
export function nextPid(hooks: Hooks, step: TxStep): Promise<number> {
  return new Promise<number>((resolve) => {
    hooks.onSql(step, (pid) => {
      resolve(pid);
      return Promise.resolve();
    });
  });
}

export async function terminate(db: Kysely<DB>, pid: number): Promise<void> {
  await sql`SELECT pg_terminate_backend(${pid})`.execute(db);
}

// ---- requests ------------------------------------------------------------------------------

/** Deterministic stand-in of the BR-AI-19 redaction function (its owner is B3-03d's). */
export function redact(text: string): RedactedText {
  return text.replace(/1[3-9]\d{9}/g, '1**********') as RedactedText;
}

export function member(): QuotaSubject {
  return { tier: 'member', userId: randomUUID() };
}
export function guest(deviceHash: string, ipKey: string, loggedIn = false): QuotaSubject {
  return { tier: 'guest', loggedIn, deviceHash, ipKey };
}
export function opaque(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function request(
  subject: QuotaSubject,
  sessionId: string,
  clientMsgId: string = opaque('m'),
  text = '帮我找一款保温杯',
): AdmissionRequest {
  return {
    sessionId,
    clientMsgId,
    runId: randomUUID(),
    messageId: randomUUID(),
    subject,
    reply: {
      assistantMessageId: randomUUID(),
      promptVersion: 'agent-prompt@7',
      modelSnapshot: 'qwen-plus-2026-09',
      runUserText: redact(text),
      messageText: redact(text),
    },
  };
}

/** Wide limits; a test narrows only the one it exercises. */
export function limits(narrow: Partial<AdmissionLimits> = {}): AdmissionLimits {
  return {
    memberDaily: 100,
    guestDaily: 100,
    guestIpDaily: 100,
    perMinute: 100,
    maxRounds: 100,
    ...narrow,
  };
}

export function accepted(result: AdmissionResult): { ticket: AdmissionTicket; quotaLeft: number } {
  expect(result.kind).toBe('accepted');
  if (result.kind !== 'accepted') throw new Error(`expected accepted: ${JSON.stringify(result)}`);
  return { ticket: result.ticket, quotaLeft: result.quotaLeft };
}

// ---- frames --------------------------------------------------------------------------------

export function draftOf(ending: RunEnding): TerminalDraft {
  const error = (code: number, retryable: boolean): TerminalDraft => ({
    event: 'error',
    data: { code, msg: texts.errorMsg(code), retryable, fallback: null },
  });
  switch (ending) {
    case 'consent_withdrawn':
      return error(10004, false);
    case 'disabled':
      return error(30501, false);
    case 'server_error':
      return error(50001, true);
    case 'client_error':
      return error(30503, false);
    case 'cancelled':
    case 'disconnected':
      return { event: 'done', data: { finish_reason: 'cancelled' } };
    case 'input_review_timeout':
      return { event: 'done', data: { finish_reason: 'error' } };
    default:
      return { event: 'done', data: { finish_reason: ending } };
  }
}

/** The recovery result without an ending on the row (BR-AI-23 细则: 50001). */
export const RECOVERED: TerminalFrame = {
  event: 'error',
  data: { code: 50001, msg: '错误提示-50001', retryable: true, fallback: null },
};

export function doneFrame(finish: string, quotaLeft: number): TerminalFrame {
  return { event: 'done', data: { finish_reason: finish, quota_left: quotaLeft } } as TerminalFrame;
}

/** The persisted form expected in final_event / end_draft. */
export function stored(frame: TerminalFrame | TerminalDraft): Row {
  return { type: frame.event, data: frame.data };
}

// ---- instances -----------------------------------------------------------------------------

export class MutableLimits implements QuotaLimitsSource {
  value: AdmissionLimits;
  fail = false;
  calls = 0;
  constructor(value: AdmissionLimits = limits()) {
    this.value = value;
  }
  current(appId: string): Promise<AdmissionLimits> {
    this.calls += 1;
    expect(appId).toBe(APP);
    if (this.fail) return Promise.reject(new Error('config read failed'));
    return Promise.resolve({ ...this.value });
  }
}

/** Thrown by a crash point: the instance is dead from then on (every later SQL is refused). */
export class Crash extends Error {}

type Waiter = (pid: number) => Promise<void>;

export class Hooks implements TxHooks {
  dead = false;
  readonly crashes: string[] = [];
  readonly steps: string[] = [];
  #crashAt: { point: CrashPoint; phase: 'before' | 'after' } | null = null;
  #sql = new Map<TxStep, Waiter[]>();
  #commit = new Map<TxStep, Waiter[]>();
  #after = new Map<TxStep, (() => Promise<void>)[]>();

  /** The next time `point` reaches `phase`, the instance dies there. */
  crashAt(point: CrashPoint, phase: 'before' | 'after'): void {
    this.#crashAt = { point, phase };
  }
  /** One-shot: runs `fn(pid)` before the next SQL statement of `step`. */
  onSql(step: TxStep, fn: Waiter): void {
    this.#sql.set(step, [...(this.#sql.get(step) ?? []), fn]);
  }
  /** One-shot: runs `fn(pid)` before the next COMMIT of `step` (locks held). */
  onCommit(step: TxStep, fn: Waiter): void {
    this.#commit.set(step, [...(this.#commit.get(step) ?? []), fn]);
  }
  /** One-shot: runs `fn` after the next COMMIT of `step`; a rejection = reply lost. */
  onAfterCommit(step: TxStep, fn: () => Promise<void>): void {
    this.#after.set(step, [...(this.#after.get(step) ?? []), fn]);
  }
  /** Holds the next COMMIT of `step`: `reached` gives its pid, `release()` lets it go on. */
  hold(step: TxStep): { reached: Promise<number>; release: () => void } {
    let reached!: (pid: number) => void;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const at = new Promise<number>((resolve) => (reached = resolve));
    this.onCommit(step, async (pid) => {
      reached(pid);
      await gate;
    });
    return { reached: at, release };
  }
  async beforeSql(step: TxStep, pid: number): Promise<void> {
    this.steps.push(`sql:${step}`);
    if (this.dead) throw new Crash('dead instance');
    const fn = this.#sql.get(step)?.shift();
    if (fn) await fn(pid);
  }
  async beforeCommit(step: TxStep, pid: number): Promise<void> {
    this.steps.push(`commit:${step}`);
    if (this.dead) throw new Crash('dead instance');
    const fn = this.#commit.get(step)?.shift();
    if (fn) await fn(pid);
  }
  async afterCommit(step: TxStep): Promise<void> {
    this.steps.push(`committed:${step}`);
    const fn = this.#after.get(step)?.shift();
    if (fn) await fn();
  }
  crash(point: CrashPoint, phase: 'before' | 'after'): void {
    if (this.dead) throw new Crash('dead instance');
    if (this.#crashAt?.point === point && this.#crashAt.phase === phase) {
      this.#crashAt = null;
      this.dead = true;
      this.crashes.push(`${point}:${phase}`);
      throw new Crash(`crash ${point} ${phase}`);
    }
  }
}

/** Redis-like cancel signal port; `broken` makes every call reject (Redis down). */
export class FakeSignals implements Pick<RunRegistry, 'requestCancel' | 'cancelRequested'> {
  readonly set = new Set<string>();
  broken = false;
  requestCancel(runId: string): Promise<'ok' | 'not_found'> {
    if (this.broken) return Promise.reject(new Error('redis down'));
    this.set.add(runId);
    return Promise.resolve('ok');
  }
  cancelRequested(runId: string): Promise<boolean> {
    if (this.broken) return Promise.reject(new Error('redis down'));
    return Promise.resolve(this.set.has(runId));
  }
}

export interface Inst {
  readonly clock: FixedClock;
  readonly hooks: Hooks;
  readonly limits: MutableLimits;
  readonly signals: FakeSignals;
  readonly ports: PgRunPorts;
}

export function instance(
  db: Kysely<DB>,
  options: {
    clock?: FixedClock;
    limits?: MutableLimits;
    timings?: RunTimings;
    signals?: FakeSignals;
    noSignals?: boolean;
  } = {},
): Inst {
  const clock = options.clock ?? new FixedClock(START);
  const hooks = new Hooks();
  const source = options.limits ?? new MutableLimits();
  const signals = options.signals ?? new FakeSignals();
  const ports = createPgRunPorts({
    db,
    clock,
    timings: options.timings ?? TIMINGS,
    limits: source,
    texts,
    ...(options.noSignals === true ? {} : { signals }),
    hooks,
  });
  return { clock, hooks, limits: source, signals, ports };
}

/** Swallows the error of a dead instance's call; returns it for inspection. */
export async function settled<T>(work: Promise<T>): Promise<T | Error> {
  try {
    return await work;
  } catch (error) {
    return error as Error;
  }
}

/**
 * The live tail as RunManager runs it (design §3.1): S4 at choose, S4′ with the draft, S5 settle,
 * S6 finish; returns what settle returned and the frame the manager would send.
 */
export async function liveTail(
  inst: Inst,
  ticket: AdmissionTicket,
  ending: RunEnding,
  cardsDelivered = 0,
  draft: TerminalDraft = draftOf(ending),
): Promise<{ refunded: boolean; quotaLeft: number; sent: TerminalFrame }> {
  const facts = { ending, cardsDelivered };
  await inst.ports.registry.recordEnding(ticket.runId, facts, draft);
  await inst.ports.registry.recordFacts(ticket.runId, facts, draft);
  const settledResult = await inst.ports.admission.settle(ticket, facts, inst.limits.value);
  const local: TerminalFrame =
    draft.event === 'done'
      ? ({
          event: 'done',
          data: { ...draft.data, quota_left: settledResult.quotaLeft },
        } as TerminalFrame)
      : draft;
  const sent = await inst.ports.registry.finish(ticket.runId, local);
  return { ...settledResult, sent };
}

/** Count of today's unrefunded runs of one quota subject key (the BR-AI-15 oracle, in SQL). */
export async function usedOn(db: Kysely<DB>, subjectKey: string, day: string): Promise<number> {
  const r = await sql<{ n: string }>`SELECT count(*) AS n FROM app.agent_runs
    WHERE app_id = ${APP} AND ${subjectKey} = ANY(quota_subjects)
      AND (accepted_at AT TIME ZONE 'Asia/Shanghai')::date = ${day}::date
      AND settle_result IS DISTINCT FROM 'refunded'`.execute(db);
  return Number(r.rows[0]!.n);
}

export function memberKey(subject: QuotaSubject): string {
  if (subject.tier !== 'member') throw new Error('member only');
  return JSON.stringify(['member', subject.userId]);
}
