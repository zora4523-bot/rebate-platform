// B3-03h fixture: the left-over run sweeper on the worker (design couli-runs/B3-03g/design.md v5
// §5.3, §7.4 B3-03h, §10.1 T10 / T14; BR-AI-23 细则「受理记录与收尾 · 谁来收尾」「崩溃不改变结果」,
// BR-AI-15 退还). Pieces:
// - databases: one fresh PostgreSQL database per test (the sweeper reads every eligible session and
//   the advisory lock is per database), with extra pools on the same database for a second worker;
//   the integration test passes createTestDatabase (only *.int.test.ts may import
//   @couli/db/testing, .dependency-cruiser.cjs testcontainers-only-in-int-tests);
// - processes: one "process" = real B3-03g ports (createPgRunPorts), a real RunManager (B3-03b)
//   on them, the real session store and the real HTTP handler (B3-03d createAgentHttp); doubles
//   only for access / identity / consent (always pass), the redactor, the labels and the run body.
//   A process "dies" by never being driven again: its run body never settles and its manual
//   scheduler is never advanced, so no ending, no settle and no finish is ever written by it;
// - a manual schedule (AgentSweepSchedule) that fires timers on demand: no real time is waited;
// - a root logger writing JSON lines to memory.
// Everything under test is built inside tests (never in hooks), so the NotImplemented of the
// skeleton reddens each test itself. Expected values stay in the rule tests.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, expect } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import { createContentReader } from '../../../../apps/api/src/modules/content/index.ts';
import {
  createAgentHttp,
  type AgentCaller,
  type AgentHttp,
} from '../../../../apps/api/src/modules/agent/http/index.ts';
import {
  agentSessionDefaults,
  createPgAgentSessionStore,
} from '../../../../apps/api/src/modules/agent/store/index.ts';
import {
  createPgRunPorts,
  createQuotaLimitsSource,
  runTimingsDefaults,
  type PgRunPorts,
  type QuotaLimitsSource,
} from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import {
  createRunManager,
  runConfigDefaults,
  type RunBody,
  type RunTexts,
} from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import type {
  FinalizeOutcome,
  Finalizer,
} from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import {
  sweepStart,
  type SweepCursor,
  type SweepResult,
  type Sweeper,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/index.ts';
import type {
  AgentSweepSchedule,
  AgentSweepTimer,
  AgentSweepTimerHandle,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/loop.ts';
import { agentDefaultTexts } from '../../../../apps/api/src/modules/agent/agent.module.ts';
import { connect, insertRow, newUser } from '../../db/linking-bindings/kit.ts';
import {
  FakeCards,
  FakeGuard,
  ManualTime,
  framesOf,
  never,
  texts as runKitTexts,
} from '../stream-run/kit.ts';
import { FakeReply, LABELS, modelLabelOf, redacted } from '../stream-http/kit.ts';
import { FakeSignals, type FixtureDatabase, type Row } from '../stream-finalize/kit.ts';

export { FakeReply } from '../stream-http/kit.ts';
export { FakeSignals, type FixtureDatabase, type Row } from '../stream-finalize/kit.ts';
export { framesOf, type Frame } from '../stream-run/kit.ts';

export const APP = 'couli';
/** 2026-10-06T10:00:00+08:00 (one Shanghai day for every run of a test). */
export const START_MS = Date.parse('2026-10-06T10:00:00+08:00');
export const DAY = '2026-10-06';

const TEXTS_FILE = new URL('../../../../contracts/texts.default.json', import.meta.url);

/**
 * The server-side default text of error <code> per contracts/texts.default.json: the
 * 「变量缺失时」 form (fallbacks) when there is one, else the default text, else that of 50001.
 */
export function fileErrorMsg(code: number): string {
  const file = JSON.parse(readFileSync(TEXTS_FILE, 'utf8')) as {
    texts: Record<string, string>;
    fallbacks: Record<string, string>;
  };
  const key = `error.${String(code)}`;
  const found = file.fallbacks[key] ?? file.texts[key] ?? file.fallbacks['error.50001'];
  expect(found, `texts.default.json ${key}`).toBeTypeOf('string');
  return found!;
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Bounded polling until `ready()` holds (database work in flight needs real I/O time; this never
 * waits for a loop period: ticks only run when the manual schedule fires them).
 */
export async function until(what: string, ready: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 2_000; i += 1) {
    if (await ready()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  expect.fail(`never happened: ${what}`);
}

// ---- databases -----------------------------------------------------------------------------

export interface PgEach {
  /** The pool of this test (max 24). */
  readonly db: Kysely<DB>;
  /** Another pool on the same database (a second worker process); destroyed after the test. */
  pool(): Kysely<DB>;
}

/** Registers beforeEach / afterEach: a fresh database per test. */
export function usePgEach(createDatabase: () => Promise<FixtureDatabase>): PgEach {
  let database: FixtureDatabase | undefined;
  let pools: Kysely<DB>[] = [];
  beforeEach(async () => {
    database = await createDatabase();
    const db = createDb({ connectionString: database.urlFor('couli_app'), max: 24 });
    pools = [db];
    connect(db);
  }, 180_000);
  afterEach(async () => {
    for (const pool of pools) await destroyDb(pool);
    if (database) await database.drop();
    pools = [];
    database = undefined;
  });
  return {
    get db() {
      const db = pools[0];
      if (db === undefined) throw new Error('database not ready');
      return db;
    },
    pool() {
      if (database === undefined) throw new Error('database not ready');
      const db = createDb({ connectionString: database.urlFor('couli_app'), max: 8 });
      pools.push(db);
      return db;
    },
  };
}

/** Backends of this database holding an advisory lock (granted). */
export async function advisoryHolders(db: Kysely<DB>): Promise<number[]> {
  const r = await sql<{ pid: number }>`SELECT pid FROM pg_locks
    WHERE locktype = 'advisory' AND granted
      AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    ORDER BY pid`.execute(db);
  return r.rows.map((row) => row.pid);
}

export async function terminate(db: Kysely<DB>, pid: number): Promise<void> {
  await sql`SELECT pg_terminate_backend(${pid})`.execute(db);
}

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

export async function runsOf(db: Kysely<DB>, sessionId: string): Promise<Row[]> {
  const r = await sql<Row>`SELECT * FROM app.agent_runs WHERE session_id = ${sessionId}
    ORDER BY accepted_at, id`.execute(db);
  return r.rows;
}

/** Every row of the agent tables, as text: equal snapshots = nothing was written. */
export async function agentSnapshot(db: Kysely<DB>): Promise<string> {
  const parts: string[] = [];
  for (const table of ['agent_sessions', 'agent_runs', 'agent_messages']) {
    const r = await sql<{ j: unknown }>`SELECT to_jsonb(t) AS j FROM ${sql.table(`app.${table}`)} t
      ORDER BY id`.execute(db);
    parts.push(JSON.stringify(r.rows.map((row) => row.j)));
  }
  return parts.join('\n');
}

/** Today's unrefunded runs of a member (the BR-AI-15 oracle, in SQL). */
export async function usedOf(db: Kysely<DB>, userId: string, day: string = DAY): Promise<number> {
  const key = JSON.stringify(['member', userId]);
  const r = await sql<{ n: string }>`SELECT count(*) AS n FROM app.agent_runs
    WHERE app_id = ${APP} AND ${key} = ANY(quota_subjects)
      AND (accepted_at AT TIME ZONE 'Asia/Shanghai')::date = ${day}::date
      AND settle_result IS DISTINCT FROM 'refunded'`.execute(db);
  return Number(r.rows[0]!.n);
}

// ---- callers -------------------------------------------------------------------------------

let traceNo = 0;

/** A member with a bound phone, on a real devices row and a real users row. */
export async function newMember(db: Kysely<DB>): Promise<AgentCaller> {
  connect(db);
  const deviceId = randomUUID();
  await insertRow('devices', {
    id: deviceId,
    app_id: APP,
    user_id: null,
    install_secret_cipher: Buffer.from('synthetic-install-secret'),
    last_seen_at: new Date(START_MS - 3_600_000),
  });
  const userId = await newUser({ app_id: APP });
  traceNo += 1;
  return {
    appId: APP,
    traceId: `trace_b3_03h_${traceNo}`,
    deviceId,
    deviceHash: `dh-${deviceId}`,
    ipKey: `ipk-${deviceId}`,
    userId,
    phoneBound: true,
  };
}

export function retrace(caller: AgentCaller): AgentCaller {
  traceNo += 1;
  return { ...caller, traceId: `trace_b3_03h_${traceNo}` };
}

// ---- processes -----------------------------------------------------------------------------

/** UUIDv7-shaped ids (version nibble 7, variant 8), random otherwise. */
export function newId(): string {
  const hex = randomUUID().replace(/-/g, '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const pass = { check: () => Promise.resolve(null) };

export interface Proc {
  readonly clock: FixedClock;
  /** The manual scheduler of this process's RunManager (never driven for a dead process). */
  readonly time: ManualTime;
  readonly ports: PgRunPorts;
  readonly limits: QuotaLimitsSource;
  readonly http: AgentHttp;
  /** The run body of the next accepted message. */
  body: RunBody;
}

/** A body that writes text and ends with done stop. */
export const talking: RunBody = (ctx) => {
  ctx.text('提现记录在「我的-提现记录」里');
  return Promise.resolve({ kind: 'done', finishReason: 'stop' });
};

/** A body that never settles: the process dies while the run is live. */
export const dying: RunBody = () => never();

/**
 * One API process at `atMs` on `db`. signals: a Redis-like fast path given to both the PG ports
 * and the HTTP layer ('absent': none at all).
 */
export function proc(
  db: Kysely<DB>,
  atMs: number,
  options: { signals?: FakeSignals | 'absent'; body?: RunBody } = {},
): Proc {
  const clock = new FixedClock(new Date(atMs));
  const time = new ManualTime();
  const timings = runTimingsDefaults();
  const errorTexts = agentDefaultTexts();
  const runTexts: RunTexts = { text: runKitTexts.text, errorMsg: (c) => errorTexts.errorMsg(c) };
  const limits = createQuotaLimitsSource({ reader: createContentReader({ db, clock }) });
  const signals = options.signals === 'absent' ? undefined : (options.signals ?? new FakeSignals());
  const ports = createPgRunPorts({
    db,
    clock,
    timings,
    limits,
    texts: errorTexts,
    ...(signals === undefined ? {} : { signals }),
  });
  const manager = createRunManager({
    admission: ports.admission,
    registry: ports.registry,
    cards: new FakeCards(),
    texts: runTexts,
    guard: new FakeGuard(),
    clock,
    scheduler: time.scheduler,
    config: { ...runConfigDefaults(), maxRunMs: timings.runMaxMs },
  });
  const p: Proc = {
    clock,
    time,
    ports,
    limits,
    body: options.body ?? talking,
    http: undefined as unknown as AgentHttp,
  };
  (p as { http: AgentHttp }).http = createAgentHttp({
    access: pass,
    identity: pass,
    consent: pass,
    sessions: createPgAgentSessionStore({ db, clock, idleMs: agentSessionDefaults().idleMs }),
    admission: ports.admission,
    runs: manager,
    cancel: (query) => ports.cancel(query),
    ...(signals === undefined ? {} : { signals }),
    limits,
    body: () => p.body,
    redactor: { redact: (_appId: string, text: string) => Promise.resolve(redacted(text)) },
    labels: {
      current: () =>
        Promise.resolve({
          promptVersion: LABELS.promptVersion,
          modelSnapshot: LABELS.modelSnapshot,
        }),
      modelLabel: (_appId: string, snapshot: string | null) =>
        Promise.resolve(modelLabelOf(snapshot)),
      aiLabel: () => Promise.resolve(LABELS.aiLabel),
    },
    settings: { textMaxCodePoints: 500 },
    texts: errorTexts,
    ids: newId,
    clock,
  });
  return p;
}

/** createSession through the HTTP layer; returns the new session id. */
export async function openSession(p: Proc, caller: AgentCaller): Promise<string> {
  const reply = new FakeReply();
  await p.http.createSession(caller, reply);
  const call = reply.single();
  expect(call.status).toBe(200);
  const id = (call.body['data'] as Row)['session_id'];
  expect(id, 'session id').toBeTypeOf('string');
  return id as string;
}

export function message(clientMsgId: string = `m-${randomUUID()}`, text = '提现记录在哪看'): Row {
  return { client_msg_id: clientMsgId, text };
}

/**
 * sendMessage on a live process whose body ends at once: the run's tail needs no manager time
 * (pings, polls and the time limit only sleep on the manual scheduler, which is not advanced).
 */
export async function sendLive(
  p: Proc,
  caller: AgentCaller,
  sessionId: string,
  body: Row,
): Promise<FakeReply> {
  const reply = new FakeReply();
  await p.http.sendMessage(caller, sessionId, body, reply);
  return reply;
}

/**
 * sendMessage on a process that then dies: returns once the acceptance committed (the meta frame
 * was written); the handler is left pending forever and the process is never driven again.
 */
export async function sendAndDie(
  p: Proc,
  caller: AgentCaller,
  sessionId: string,
  body: Row,
): Promise<{ reply: FakeReply; runId: string }> {
  p.body = dying;
  const reply = new FakeReply();
  void p.http.sendMessage(caller, sessionId, body, reply).catch(() => undefined);
  await until('the meta frame of the accepted run', () => framesOf(reply.chunks).length > 0);
  expect(reply.jsons, 'accepted: no JSON answer').toEqual([]);
  const [meta] = framesOf(reply.chunks);
  expect(meta!.event).toBe('meta');
  const runId = meta!.data['run_id'];
  expect(runId).toBeTypeOf('string');
  return { reply, runId: runId as string };
}

// ---- schedule and logs ---------------------------------------------------------------------

export interface Armed {
  readonly run: () => Promise<void>;
  readonly delayMs: number;
  readonly timer: AgentSweepTimer;
  cancelled: boolean;
  fired: boolean;
}

/** AgentSweepSchedule whose timers fire only when the test says so. */
export class ManualSchedule {
  readonly armed: Armed[] = [];
  readonly schedule: AgentSweepSchedule = (run, delayMs, timer): AgentSweepTimerHandle => {
    const entry: Armed = { run, delayMs, timer, cancelled: false, fired: false };
    this.armed.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  };
  /** Armed, not cancelled and not fired yet, of one purpose. */
  pending(timer: AgentSweepTimer): Armed[] {
    return this.armed.filter((a) => a.timer === timer && !a.cancelled && !a.fired);
  }
  /** Fires the oldest pending timer of `timer`; returns what its run returned. */
  fire(timer: AgentSweepTimer): Promise<void> {
    const next = this.pending(timer)[0];
    expect(next, `a pending '${timer}' timer`).toBeDefined();
    next!.fired = true;
    return next!.run();
  }
  /** Fires a timer even if it was cancelled (a timer callback already queued in the event loop). */
  fireLate(entry: Armed): Promise<void> {
    entry.fired = true;
    return entry.run();
  }
}

export interface LogLine {
  readonly level: number;
  readonly msg: string;
  readonly [field: string]: unknown;
}

/** A root logger at level trace writing JSON lines to memory. */
export class Logs {
  readonly lines: string[] = [];
  readonly logger: RootLogger = createRootLogger(
    { level: 'trace', entry: 'worker', appEnv: 'test' },
    { write: (line: string) => void this.lines.push(line) },
  );
  all(): LogLine[] {
    return this.lines.map((line) => JSON.parse(line) as LogLine);
  }
  of(msg: string): LogLine[] {
    return this.all().filter((line) => line.msg === msg);
  }
}

export const LEVEL = { debug: 20, info: 30, warn: 40, error: 50 } as const;

// ---- sweeper doubles -----------------------------------------------------------------------

export function result(over: Partial<SweepResult> = {}): SweepResult {
  return {
    processed: 0,
    finalized: 0,
    skipped: { running: 0, held: 0 },
    failed: 0,
    nextCursor: sweepStart(),
    wrapped: true,
    ...over,
  };
}

interface Pending {
  readonly cursor: SweepCursor;
  resolve(r: SweepResult): void;
  reject(e: unknown): void;
}

/** A sweeper whose passes the test answers one by one (or that delegates to a real one). */
export class ScriptedSweeper implements Sweeper {
  readonly cursors: SweepCursor[] = [];
  readonly pending: Pending[] = [];
  /** When set, every pass is answered by it at once. */
  answer: ((cursor: SweepCursor) => Promise<SweepResult>) | null = null;
  sweepOnce(cursor: SweepCursor): Promise<SweepResult> {
    this.cursors.push(cursor);
    if (this.answer !== null) return this.answer(cursor);
    return new Promise<SweepResult>((resolve, reject) => {
      this.pending.push({ cursor, resolve, reject });
    });
  }
  /** Waits until pass number `n` (1-based) was started. */
  async started(n: number): Promise<void> {
    await until(`sweepOnce call ${String(n)}`, () => this.cursors.length >= n);
  }
}

/** Wraps a real sweeper: each pass waits at `gate` (when armed) before running. */
export class GatedSweeper implements Sweeper {
  calls = 0;
  #inner: Sweeper;
  #gate: Promise<void> | null = null;
  #open: (() => void) | null = null;
  constructor(inner: Sweeper) {
    this.#inner = inner;
  }
  close(): void {
    this.#gate = new Promise<void>((resolve) => (this.#open = resolve));
  }
  open(): void {
    this.#open?.();
    this.#gate = null;
  }
  async sweepOnce(cursor: SweepCursor): Promise<SweepResult> {
    this.calls += 1;
    if (this.#gate !== null) await this.#gate;
    return this.#inner.sweepOnce(cursor);
  }
}

/**
 * Records every finalize call into a shared event list (`<prefix>call:<label>`) and forwards to
 * the real B3-03g finalizer. With `holdFirst`, the first call waits (before touching the
 * database) until release(): a finalize that blocks longer than the tick may last.
 */
export class HeldFinalizer implements Finalizer {
  readonly calls: string[] = [];
  readonly outcomes: Promise<FinalizeOutcome | Error>[] = [];
  readonly #inner: Finalizer;
  readonly #events: string[];
  readonly #label: (runId: string) => string;
  readonly #prefix: string;
  #hold: boolean;
  #release: () => void = () => undefined;
  readonly #gate: Promise<void>;
  constructor(
    inner: Finalizer,
    events: string[],
    label: (runId: string) => string,
    options: { prefix?: string; holdFirst?: boolean } = {},
  ) {
    this.#inner = inner;
    this.#events = events;
    this.#label = label;
    this.#prefix = options.prefix ?? '';
    this.#hold = options.holdFirst ?? false;
    this.#gate = new Promise<void>((resolve) => (this.#release = resolve));
  }
  release(): void {
    this.#release();
  }
  finalize(runId: string): Promise<FinalizeOutcome> {
    this.calls.push(runId);
    this.#events.push(`${this.#prefix}call:${this.#label(runId)}`);
    const held = this.#hold;
    this.#hold = false;
    const work = held
      ? this.#gate.then(() => this.#inner.finalize(runId))
      : this.#inner.finalize(runId);
    this.outcomes.push(
      work.then(
        (o) => o,
        (e: unknown) => e as Error,
      ),
    );
    return work;
  }
}

/** Lets in-flight database work of an abandoned step show itself (bounded, a few round trips). */
export async function settleWork(db: Kysely<DB>): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await sql`SELECT 1`.execute(db);
    await flush();
  }
}
