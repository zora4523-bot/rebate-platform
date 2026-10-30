// B2-02r rule-test kit (claude-independent, SPEC_REF 37808a50): the heal of the daily ledger check
// chain, 08 BR-FUND-19 (每日 01:00 +08:00 对会计日 D−1 运行 ledger_invariants.sql). Task brief §9: a
// (app, D) whose `daily` job went to ledger-check.dead (or failed, or was never queued) is enqueued
// again by the next heal; it is skipped only when (app, D) is done or a job of the same key is
// queued / active / waiting for a retry — judged from the queue and the results, never from process
// memory, also after a restart; the re-run resumes the chain (D+1 queued); an (app, D) not done a
// grace after D+1 01:00 +08:00 is alerted once per (app, D), also across restarts; a done (app, D)
// is never queued again.
// Conventions inherited from B2-02q (../daily-check-schedule/kit.ts): queue ledger-check, job
// daily, payload { app_id, accounting_date }, singletonKey daily:<app_id>:<D>, D's run due at D+1
// 01:00 +08:00. The skeleton (application/daily-check-schedule-heal.ts) adds healDailyCheck over a
// DailyCheckRunStore port, dailyCheckOverdueAtMs, and infra createDailyCheckRunStore.
// Real pieces: PostgreSQL through @couli/db/testing as couli_app; in the store / end-to-end tests
// pg-boss on the test database (platform createQueueRuntime, api entry: sends only, nothing is
// worked) and the B2-02q `daily` handler. Synthetic: the job state transitions a worker would make
// (active, retry, failed + the dead-letter copy, cancelled, completed) written as plain SQL on
// pgboss.job (as test/spec/platform/queue does), the invariant files of the handler (clean
// fixtures), the hold / switch ports, and — in the heal tests — the run store (an in-memory stand-in
// for the database, shared across "restarts"). No real user data.
import {
  createDailyCheckJob,
  type DailyCheckRunState,
  type DailyCheckRunStore,
  type DailyCheckScheduleLogger,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  createRootLogger,
  type FixedClock,
  type JobPayload,
  type JobQueue,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createQueueRuntime } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import {
  JOB,
  QUEUE,
  clean,
  isTransaction,
  keyOf,
  recordingHolds,
  recordingSwitch,
  type FakeQueue,
  type LogLine,
  type SentJob,
} from '../daily-check-schedule/kit.ts';

export {
  APP,
  DAY,
  NEXT_DAY,
  NEXT_RUN_AT,
  OTHER,
  RUN_AT,
  THIRD,
  JOB,
  QUEUE,
  capturedWorkerOptions,
  expectedSend,
  fakeQueue,
  keyOf,
  memoryLogger,
  messages,
  rejection,
  rootLogger,
  sendView,
  sentFor,
  userAccount,
  withDatabase,
  workerContext,
} from '../daily-check-schedule/kit.ts';
export type { FakeQueue, LogLine, SentJob };

export const TIMEOUT = 120_000;
export const DEAD_QUEUE = 'ledger-check.dead';
/** The event of the chain-break alert (ledger's alert lines carry `event`, B2-02p / B2-02q). */
export const OVERDUE_EVENT = 'ledger_daily_check_overdue';
export const HOUR_MS = 3_600_000;

/** An instant (epoch milliseconds) as ISO text, for FixedClock. */
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------------------------
// The run store stand-in of the heal tests: the "database" of states and claims. A new heal call
// over the same stand-in is a restarted process (it shares nothing else).

export interface FakeRuns extends DailyCheckRunStore {
  /** keyOf(app, D) → state; a missing key is 'absent'. */
  readonly states: Map<string, DailyCheckRunState>;
  /** keyOf(app, D) of every claim granted. */
  readonly claimed: Set<string>;
  /** keyOf(app, D) of every stateOf call, in order. */
  readonly reads: string[];
}

export function fakeRuns(): FakeRuns {
  const states = new Map<string, DailyCheckRunState>();
  const claimed = new Set<string>();
  const reads: string[] = [];
  return {
    states,
    claimed,
    reads,
    async stateOf(appId, accountingDate) {
      const key = keyOf(appId, accountingDate);
      reads.push(key);
      return states.get(key) ?? 'absent';
    },
    async claimOverdueAlert(appId, accountingDate) {
      const key = keyOf(appId, accountingDate);
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
  };
}

/** The overdue alert lines of a memory logger (any level), for one app when given. */
export function overdueLines(lines: readonly LogLine[], appId?: string): LogLine[] {
  return lines.filter(
    (line) =>
      line.fields['event'] === OVERDUE_EVENT &&
      (appId === undefined || line.fields['app_id'] === appId),
  );
}

// ---------------------------------------------------------------------------------------------
// pg-boss on the test database.

/**
 * A started api-entry queue runtime on `db` (sends only; the api entry works no queue) behind the
 * FakeQueue shape: every send is recorded and forwarded to pg-boss; register only records.
 */
export async function withRealQueue(
  db: Kysely<DB>,
  run: (queue: FakeQueue) => Promise<void>,
): Promise<void> {
  const raw: string[] = [];
  const runtime = createQueueRuntime({
    entry: 'api',
    db,
    logger: createRootLogger(
      { entry: 'api', appEnv: 'test', level: 'warn' },
      { write: (line: string) => void raw.push(line) },
    ),
  });
  await runtime.start();
  const sent: SentJob[] = [];
  const failing = new Set<string>();
  const registered: FakeQueue['registered'][number][] = [];
  const queue: FakeQueue = {
    sent,
    failing,
    registered,
    async send(queueName, name, payload, options) {
      const appId = payload['app_id'];
      if (typeof appId === 'string' && failing.has(appId)) {
        throw new Error('synthetic send failure');
      }
      const id = await runtime.send(queueName, name, payload, options);
      sent.push({
        queue: queueName,
        name,
        payload,
        options,
        inTransaction: isTransaction(options.trx),
      });
      return id;
    },
    register(queueName, handler) {
      registered.push({ queue: queueName, handler });
    },
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
  try {
    await run(queue);
  } finally {
    await runtime.stop();
  }
}

export interface DailyJobRow {
  readonly id: string;
  readonly state: string;
  readonly singleton_key: string | null;
  readonly payload: JobPayload | null;
}

/** The `daily` jobs of (app, D) on queue ledger-check (pgboss.job), oldest first. */
export async function dailyJobs(
  db: Kysely<DB>,
  appId: string,
  day: string,
): Promise<DailyJobRow[]> {
  const result = await sql<DailyJobRow>`
    SELECT id::text AS id, state::text AS state, singleton_key, data -> 'payload' AS payload
    FROM pgboss.job
    WHERE name = ${QUEUE} AND singleton_key = ${keyOf(appId, day)}
    ORDER BY created_on, id`.execute(db);
  return result.rows;
}

/** The states of the `daily` jobs of (app, D), oldest first. */
export async function statesOf(db: Kysely<DB>, appId: string, day: string): Promise<string[]> {
  return (await dailyJobs(db, appId, day)).map((row) => row.state);
}

/** The one job of (app, D) still queued, active or retrying (fails the caller's assertion if not). */
export async function liveJob(db: Kysely<DB>, appId: string, day: string): Promise<DailyJobRow> {
  const live = (await dailyJobs(db, appId, day)).filter((row) =>
    ['created', 'retry', 'active'].includes(row.state),
  );
  if (live.length !== 1) {
    throw new Error(`expected one live job of ${keyOf(appId, day)}, found ${live.length}`);
  }
  return live[0]!;
}

export type WorkerTransition = 'active' | 'retry' | 'completed' | 'cancelled';

/** What a worker does to a job (plain SQL on pgboss.job; no handler involved). */
export async function transition(
  db: Kysely<DB>,
  jobId: string,
  state: WorkerTransition,
): Promise<void> {
  switch (state) {
    case 'active':
      await sql`UPDATE pgboss.job SET state = 'active', started_on = now()
        WHERE name = ${QUEUE} AND id = ${jobId}::uuid`.execute(db);
      return;
    case 'retry':
      await sql`UPDATE pgboss.job SET state = 'retry', retry_count = retry_count + 1,
          started_on = NULL, start_after = now() + interval '10 seconds'
        WHERE name = ${QUEUE} AND id = ${jobId}::uuid`.execute(db);
      return;
    case 'completed':
      await sql`UPDATE pgboss.job SET state = 'completed', completed_on = now(),
          started_on = COALESCE(started_on, now())
        WHERE name = ${QUEUE} AND id = ${jobId}::uuid`.execute(db);
      return;
    case 'cancelled':
      await sql`UPDATE pgboss.job SET state = 'cancelled', completed_on = now()
        WHERE name = ${QUEUE} AND id = ${jobId}::uuid`.execute(db);
      return;
  }
}

/**
 * Retries exhausted: the job fails with the runtime's stored output and pg-boss's copy waits in
 * ledger-check.dead (same data; the copy also keeps the singletonKey here, so a reader that
 * ignores the queue name would wrongly see it as pending).
 */
export async function failToDead(db: Kysely<DB>, jobId: string): Promise<void> {
  await sql`UPDATE pgboss.job SET state = 'failed', retry_count = retry_limit,
      started_on = COALESCE(started_on, now()), completed_on = now(),
      output = '{"error":"handler_failed"}'::jsonb
    WHERE name = ${QUEUE} AND id = ${jobId}::uuid`.execute(db);
  await sql`INSERT INTO pgboss.job (name, data, state, singleton_key, output)
    SELECT ${DEAD_QUEUE}, data, 'created'::pgboss.job_state, singleton_key, output
    FROM pgboss.job WHERE name = ${QUEUE} AND id = ${jobId}::uuid`.execute(db);
}

/** The ledger-check.dead copies naming (app, D). */
export async function deadCopies(db: Kysely<DB>, appId: string, day: string): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM pgboss.job
    WHERE name = ${DEAD_QUEUE}
      AND data -> 'payload' ->> 'app_id' = ${appId}
      AND data -> 'payload' ->> 'accounting_date' = ${day}`.execute(db);
  return result.rows[0]?.n ?? 0;
}

/**
 * A worker running the live job of (app, D) to completion: active, the B2-02q `daily` handler over
 * clean fixture invariants (it enqueues D+1 on `queue`), then completed.
 */
export async function completeRun(
  db: Kysely<DB>,
  clock: FixedClock,
  queue: JobQueue,
  logger: DailyCheckScheduleLogger,
  appId: string,
  day: string,
): Promise<void> {
  const job = await liveJob(db, appId, day);
  await transition(db, job.id, 'active');
  const handler = createDailyCheckJob({
    db,
    clock,
    queue,
    logger,
    holds: recordingHolds(clock),
    autoSettlement: recordingSwitch(),
    invariants: {
      async load() {
        return [clean('01_fixture-balance.sql', '01'), clean('02_fixture-vouchers.sql', '02')];
      },
    },
  });
  await handler({
    id: job.id,
    queue: QUEUE,
    name: JOB,
    payload: job.payload ?? {},
    attempt: 1,
  });
  await transition(db, job.id, 'completed');
}
