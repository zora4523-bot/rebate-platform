// B3-03e fixture: one fresh PostgreSQL database per test (the sweeper reads every eligible session
// of the database, so tests must not see each other's left-over runs). The integration test passes
// createTestDatabase: only *.int.test.ts files may import @couli/db/testing
// (.dependency-cruiser.cjs testcontainers-only-in-int-tests). Left-over runs are made either the
// real way (admit on a B3-03g instance whose process then "dies": no settle) or, for the cursor
// tests that need many rows or chosen session ids, by direct inserts of the same columns. The
// sweeper is only built inside tests (never in hooks), so the NotImplemented of the skeleton
// reddens the test itself. Expected values stay in the rule tests.
import { randomUUID } from 'node:crypto';

import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterEach, beforeEach, expect } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  subjectKeys,
  type QuotaSubject,
  type RunEnding,
} from '../../../../apps/api/src/modules/agent/stream/admission/index.ts';
import type {
  FinalizeOutcome,
  Finalizer,
} from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import {
  createSweeper,
  type Sweeper,
  type SweeperConfig,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/index.ts';
import { connect, insertRow } from '../../db/linking-bindings/kit.ts';
import {
  APP,
  TIMINGS,
  accepted,
  draftOf,
  instance,
  limits,
  member,
  request,
  type FixtureDatabase,
  type Inst,
  type Pg,
} from '../stream-finalize/kit.ts';

/** Lock period written at acceptance (design §5.1): accepted_at + runMaxMs + lockGraceMs. */
export const LOCK_MS = TIMINGS.runMaxMs + TIMINGS.lockGraceMs;

export const at = (ms: number): FixedClock => new FixedClock(new Date(ms));

// ---- database ------------------------------------------------------------------------------

/** Registers beforeEach / afterEach: a fresh database per test; `pg.db` inside tests. */
export function usePgEach(createDatabase: () => Promise<FixtureDatabase>): Pg {
  let database: FixtureDatabase | undefined;
  let db: Kysely<DB> | undefined;
  beforeEach(async () => {
    database = await createDatabase();
    db = createDb({ connectionString: database.urlFor('couli_app'), max: 24 });
    connect(db);
  });
  afterEach(async () => {
    if (db) await destroyDb(db);
    if (database) await database.drop();
    db = undefined;
    database = undefined;
  });
  return {
    get db() {
      if (db === undefined) throw new Error('database not ready');
      return db;
    },
  };
}

async function newDevice(db: Kysely<DB>, when: Date): Promise<string> {
  connect(db);
  const deviceId = randomUUID();
  await insertRow('devices', {
    id: deviceId,
    app_id: APP,
    user_id: null,
    install_secret_cipher: Buffer.from('synthetic-install-secret'),
    last_seen_at: when,
  });
  return deviceId;
}

/** A device-owned session with a chosen id, started 1 s before `atMs`. */
export async function newSessionWithId(db: Kysely<DB>, id: string, atMs: number): Promise<string> {
  const when = new Date(atMs - 1_000);
  const deviceId = await newDevice(db, when);
  await sql`INSERT INTO app.agent_sessions (id, app_id, device_id, started_at, last_active_at)
    VALUES (${id}, ${APP}, ${deviceId}, ${when}, ${when})`.execute(db);
  return id;
}

// ---- left-over runs ------------------------------------------------------------------------

export interface Leftover {
  readonly runId: string;
  readonly sessionId: string;
  readonly subject: QuotaSubject;
  readonly acceptedAtMs: number;
  /** run_lock_expires_at written at acceptance. */
  readonly lockMs: number;
  /** The accepting instance (dead after `leftover` returns: nothing else is called on it). */
  readonly inst: Inst;
}

/**
 * The real left-over: admit at `acceptedAtMs` on a B3-03g instance, optionally commit card
 * delivery (S3) and / or a user cancel (the cancel endpoint's write), then the process dies before
 * any ending is written (no S4, no settle). With `ending`, the live process chose that ending and
 * committed it (registry.recordEnding = S4, the decision UPDATE, with `cards` and the ending's
 * draft) and then died before settling (no settle, no finish): end_reason set, final_event NULL.
 * `sessionId` reuses an existing session.
 */
export async function leftover(
  db: Kysely<DB>,
  acceptedAtMs: number,
  options: {
    sessionId?: string;
    subject?: QuotaSubject;
    cards?: number;
    cancel?: boolean;
    ending?: RunEnding;
  } = {},
): Promise<Leftover> {
  const inst = instance(db, { clock: at(acceptedAtMs) });
  const sessionId = options.sessionId ?? (await newSessionWithId(db, randomUUID(), acceptedAtMs));
  const subject = options.subject ?? member();
  const { ticket } = accepted(
    await inst.ports.admission.admit(request(subject, sessionId), limits()),
  );
  if ((options.cards ?? 0) > 0) {
    await inst.ports.registry.recordFacts(ticket.runId, {
      ending: null,
      cardsDelivered: options.cards ?? 0,
    });
  }
  if (options.cancel === true) {
    expect(await inst.ports.cancel({ appId: APP, runId: ticket.runId })).toBe('accepted');
  }
  if (options.ending !== undefined) {
    await inst.ports.registry.recordEnding(
      ticket.runId,
      { ending: options.ending, cardsDelivered: options.cards ?? 0 },
      draftOf(options.ending),
    );
  }
  return {
    runId: ticket.runId,
    sessionId,
    subject,
    acceptedAtMs,
    lockMs: ticket.lockExpiresAtMs,
    inst,
  };
}

export interface SeedRow {
  readonly sessionId: string;
  readonly runId: string;
  readonly lockMs: number;
}

/**
 * Many left-over rows at once (cursor tests with a stub finalizer): per row one session, one run
 * accepted LOCK_MS before its lock expiry and without any ending, and the session lock on it.
 */
export async function seedLocks(
  db: Kysely<DB>,
  rows: readonly { readonly lockMs: number; readonly sessionId?: string }[],
): Promise<SeedRow[]> {
  const earliest = Math.min(...rows.map((r) => r.lockMs));
  const deviceId = await newDevice(db, new Date(earliest - LOCK_MS - 1_000));
  const seeded = rows.map((r) => ({
    sessionId: r.sessionId ?? randomUUID(),
    runId: randomUUID(),
    lockMs: r.lockMs,
  }));
  const json = JSON.stringify(
    seeded.map((r) => ({
      sid: r.sessionId,
      rid: r.runId,
      acc: new Date(r.lockMs - LOCK_MS).toISOString(),
      lck: new Date(r.lockMs).toISOString(),
      key: subjectKeys(member())[0],
    })),
  );
  const recordset = sql`jsonb_to_recordset(${json}::jsonb)
    AS x(sid uuid, rid uuid, acc timestamptz, lck timestamptz, key text)`;
  await sql`INSERT INTO app.agent_sessions (id, app_id, device_id, started_at, last_active_at)
    SELECT x.sid, ${APP}, ${deviceId}::uuid, x.acc - interval '1 second', x.acc
    FROM ${recordset}`.execute(db);
  await sql`INSERT INTO app.agent_runs (id, app_id, session_id, prompt_version, accepted_at,
      quota_subjects, deadline_at)
    SELECT x.rid, ${APP}, x.sid, 'agent-prompt@7', x.acc, ARRAY[x.key],
      x.acc + ${TIMINGS.runMaxMs}::int * interval '1 millisecond'
    FROM ${recordset}`.execute(db);
  await sql`UPDATE app.agent_sessions s SET run_lock_run_id = x.rid, run_lock_expires_at = x.lck
    FROM ${recordset} WHERE s.app_id = ${APP} AND s.id = x.sid`.execute(db);
  return seeded;
}

/** The sweep order of the design (§5.3): (run_lock_expires_at, session id) ascending. */
export function sweepOrder<T extends { readonly lockMs: number; readonly sessionId: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) =>
    a.lockMs !== b.lockMs
      ? a.lockMs - b.lockMs
      : a.sessionId < b.sessionId
        ? -1
        : a.sessionId > b.sessionId
          ? 1
          : 0,
  );
}

export async function markHold(db: Kysely<DB>, runId: string, atMs: number): Promise<void> {
  await sql`UPDATE app.agent_runs SET finalize_hold = 'facts_inconsistent',
    finalize_hold_at = ${new Date(atMs)} WHERE id = ${runId}`.execute(db);
}

/** Every row of the agent tables the sweeper must not write, as text. */
export async function agentSnapshot(db: Kysely<DB>): Promise<string> {
  const parts: string[] = [];
  for (const table of ['agent_sessions', 'agent_runs', 'agent_messages']) {
    const r = await sql<{ j: unknown }>`SELECT to_jsonb(t) AS j FROM ${sql.table(`app.${table}`)} t
      ORDER BY id`.execute(db);
    parts.push(JSON.stringify(r.rows.map((row) => row.j)));
  }
  return parts.join('\n');
}

/** Waits (bounded polling, no fixed sleep) until some backend is blocked by backend `blocker`. */
export async function someoneBlockedBy(db: Kysely<DB>, blocker: number): Promise<void> {
  for (let i = 0; i < 2_000; i += 1) {
    const r = await sql<{ n: string }>`SELECT count(*) AS n FROM pg_stat_activity
      WHERE ${blocker}::int = ANY(pg_blocking_pids(pid))`.execute(db);
    if (Number(r.rows[0]!.n) > 0) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect.fail(`no backend was ever blocked by backend ${String(blocker)}`);
}

// ---- finalizer doubles ---------------------------------------------------------------------

export interface Call {
  readonly runId: string;
  readonly args: number;
  readonly outcome?: FinalizeOutcome;
  readonly error?: unknown;
}

/**
 * Records every finalize call (argument, arity, outcome or rejection) and forwards to `inner`
 * (the real B3-03g finalizer, or a scripted stand-in).
 */
export class RecordingFinalizer implements Finalizer {
  readonly calls: Call[] = [];
  readonly #inner: (runId: string) => Promise<FinalizeOutcome>;
  constructor(inner: Finalizer | ((runId: string) => Promise<FinalizeOutcome>)) {
    this.#inner = typeof inner === 'function' ? inner : (runId) => inner.finalize(runId);
  }
  get runIds(): string[] {
    return this.calls.map((c) => c.runId);
  }
  async finalize(...args: [string]): Promise<FinalizeOutcome> {
    const [runId] = args;
    try {
      const outcome = await this.#inner(runId);
      this.calls.push({ runId, args: args.length, outcome });
      return outcome;
    } catch (error) {
      this.calls.push({ runId, args: args.length, error });
      throw error;
    }
  }
}

/** A stand-in that writes nothing and answers `running` (the row stays eligible). */
export const answerRunning = (): Promise<FinalizeOutcome> => Promise.resolve({ kind: 'running' });

/** Collects warn / error log calls. */
export class FakeLogger {
  readonly entries: { level: 'warn' | 'error'; args: unknown[] }[] = [];
  readonly logger = {
    warn: (...args: unknown[]) => void this.entries.push({ level: 'warn', args }),
    error: (...args: unknown[]) => void this.entries.push({ level: 'error', args }),
  } as unknown as Pick<RootLogger, 'warn' | 'error'>;
  /** Whether some entry mentions `runId` (in its object or message). */
  mentions(runId: string): boolean {
    return this.entries.some((e) => JSON.stringify(e.args).includes(runId));
  }
}

export function sweeper(
  db: Kysely<DB>,
  finalizer: Finalizer,
  clock: FixedClock,
  config: SweeperConfig,
  logger?: FakeLogger,
): Sweeper {
  return createSweeper({
    db,
    finalizer,
    clock,
    config,
    ...(logger ? { logger: logger.logger } : {}),
  });
}
