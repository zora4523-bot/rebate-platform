// B2-02s rule-test kit (claude-independent, SPEC_REF 37808a50): the durable completion record of the
// daily ledger check, 08 BR-FUND-19 (每日 01:00 +08:00 对会计日 D−1 运行 ledger_invariants.sql),
// follow-up FU-B202R-DONE-MARK of B2-02r. Task brief §9.2:
// - the `daily` handler of (app, D), once the runner and the B2-02p execution step have run to the
//   end, writes one row of app.processed_events (consumer 'ledger.daily_check_done', event_id the
//   uuid derived from app_id and D — dailyCheckDoneEventId — INSERT … ON CONFLICT DO NOTHING) on the
//   same transaction that enqueues D+1; a run that throws before that leaves no row;
// - the run store's stateOf reports an (app, D) with that row as 'done' first, even when the queue
//   holds only failed / dead-lettered jobs of its key (an attempt the queue judged failed after
//   expireInSeconds although the work had finished); without the row it answers as in B2-02r;
// - so the heal neither re-sends nor alerts a finished day.
// Conventions inherited from B2-02q / B2-02r (../daily-check-schedule/kit.ts,
// ../daily-check-heal/kit.ts): queue ledger-check, job daily, payload { app_id, accounting_date },
// singletonKey daily:<app_id>:<D>, D's run due at D+1 01:00 +08:00; the worker's state changes on
// pgboss.job written as plain SQL. The skeleton (application/daily-check-schedule-done.ts) adds
// dailyCheckDoneEventId and the type DailyCheckDoneConsumer.
// Real pieces: PostgreSQL through @couli/db/testing as couli_app (the int tests hand in
// createTestDatabase), the B2-02q handler (runner + execution step), the B2-02r run store and heal,
// and — in the store / chain tests — pg-boss on the test database (api-entry runtime: sends only).
// Synthetic: the invariant files (fixture SQL), the hold / switch ports, the job queue of the handler
// tests (a recorder that also notes the database transaction id of every send given a transaction),
// and a completion record written directly where a test needs one left behind by an earlier run.
// No real user data.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import {
  createDailyCheckJob,
  dailyCheckDoneEventId,
  type DailyCheckDoneConsumer,
  type DailyCheckScheduleLogger,
  type LedgerInvariantFile,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  FixedClock,
  type JobHandler,
  type JobQueue,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  JOB,
  QUEUE,
  clean,
  fakeQueue,
  isTransaction,
  memoryLogger,
  recordingHolds,
  recordingSwitch,
  withDatabase,
  type FakeQueue,
  type LogLine,
  type RecordingHolds,
} from '../daily-check-schedule/kit.ts';
import { failToDead, liveJob, transition } from '../daily-check-heal/kit.ts';

export {
  APP,
  DAY,
  NEXT_DAY,
  OTHER,
  RUN_AT,
  THIRD,
  JOB,
  QUEUE,
  broken,
  clean,
  dailyJob,
  differing,
  diffsOf,
  expectedSend,
  holdsOf,
  keyOf,
  ledgerCodes,
  memoryLogger,
  messages,
  rejection,
  sendView,
  sentFor,
  userAccount,
  withDatabase,
} from '../daily-check-schedule/kit.ts';
export {
  DEAD_QUEUE,
  OVERDUE_EVENT,
  deadCopies,
  failToDead,
  iso,
  liveJob,
  overdueLines,
  statesOf,
  transition,
  withRealQueue,
} from '../daily-check-heal/kit.ts';
export type { FakeQueue, LogLine };

export const TIMEOUT = 120_000;

/** The processed_events consumer of the completion record (task brief §9.2). */
export const DONE_CONSUMER: DailyCheckDoneConsumer = 'ledger.daily_check_done';

/** The consumer of B2-02r's overdue alert claim (another consumer, never a completion record). */
export const OVERDUE_ALERT_CONSUMER = 'ledger.daily_check_overdue_alert';

// ---------------------------------------------------------------------------------------------
// Completion records.

/** The completion records of (app, D): rows of DONE_CONSUMER with its event_id. */
export async function doneRecords(db: Kysely<DB>, appId: string, day: string): Promise<number> {
  const eventId = dailyCheckDoneEventId(appId, day);
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM app.processed_events
    WHERE consumer = ${DONE_CONSUMER} AND event_id = ${eventId}::uuid`.execute(db);
  return result.rows[0]?.n ?? 0;
}

/** Every completion record of any (app, D). */
export async function allDoneRecords(db: Kysely<DB>): Promise<number> {
  const result = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM app.processed_events
    WHERE consumer = ${DONE_CONSUMER}`.execute(db);
  return result.rows[0]?.n ?? 0;
}

/** The id of the transaction that wrote the completion record of (app, D) (xmin), or null. */
export async function doneRecordXid(
  db: Kysely<DB>,
  appId: string,
  day: string,
): Promise<string | null> {
  const eventId = dailyCheckDoneEventId(appId, day);
  const result = await sql<{ xid: string }>`
    SELECT xmin::text AS xid FROM app.processed_events
    WHERE consumer = ${DONE_CONSUMER} AND event_id = ${eventId}::uuid`.execute(db);
  return result.rows[0]?.xid ?? null;
}

/**
 * A processed_events row of `consumer` carrying the completion event_id of (app, D) (kept as it is
 * when that row already exists).
 */
export async function writeRecord(
  db: Kysely<DB>,
  consumer: string,
  appId: string,
  day: string,
): Promise<void> {
  const eventId = dailyCheckDoneEventId(appId, day);
  await sql`INSERT INTO app.processed_events (consumer, event_id)
    VALUES (${consumer}, ${eventId}::uuid)
    ON CONFLICT (consumer, event_id) DO NOTHING`.execute(db);
}

/** The completion record an earlier finished run of (app, D) left behind. */
export function markDone(db: Kysely<DB>, appId: string, day: string): Promise<void> {
  return writeRecord(db, DONE_CONSUMER, appId, day);
}

// ---------------------------------------------------------------------------------------------
// The handler tests' queue.

export interface XidQueue extends FakeQueue {
  /**
   * The database transaction id (32-bit, as xmin shows it) of every send given a transaction, in
   * send order; sends outside a transaction add nothing.
   */
  readonly xids: string[];
}

/** fakeQueue (B2-02q) that also notes the transaction id of each send given a transaction. */
export function xidQueue(): XidQueue {
  const inner = fakeQueue();
  const xids: string[] = [];
  return {
    ...inner,
    xids,
    async send(queue, name, payload, options) {
      const id = await inner.send(queue, name, payload, options);
      if (isTransaction(options.trx) && options.trx !== null) {
        const result = await sql<{ xid: string }>`
          SELECT (txid_current() % 4294967296)::text AS xid`.execute(options.trx);
        xids.push(result.rows[0]?.xid ?? '');
      }
      return id;
    },
  };
}

/** The clean fixture files (no differences). */
export function cleanFiles(): LedgerInvariantFile[] {
  return [clean('01_fixture-balance.sql', '01'), clean('02_fixture-vouchers.sql', '02')];
}

// ---------------------------------------------------------------------------------------------
// The handler harness.

interface TestDatabase {
  urlFor(role: 'couli_app'): string;
  drop(): Promise<void>;
}

export interface DoneHarness {
  readonly db: Kysely<DB>;
  readonly clock: FixedClock;
  readonly lines: LogLine[];
  readonly queue: XidQueue;
  readonly holds: RecordingHolds;
  /** The `daily` handler over these files. */
  readonly job: JobHandler;
}

/** A fresh database and the B2-02q `daily` handler over it, at `now`, running `files`. */
export async function withDoneHarness(
  create: () => Promise<TestDatabase>,
  setup: { readonly now: string; readonly files: () => readonly LedgerInvariantFile[] },
  run: (h: DoneHarness) => Promise<void>,
): Promise<void> {
  await withDatabase(create, async (db) => {
    const clock = new FixedClock(setup.now);
    const { logger, lines } = memoryLogger();
    const queue = xidQueue();
    const holds = recordingHolds(clock);
    const job = createDailyCheckJob({
      db,
      clock,
      queue,
      logger,
      holds,
      autoSettlement: recordingSwitch(),
      invariants: {
        async load() {
          return setup.files();
        },
      },
    });
    await run({ db, clock, lines, queue, holds, job });
  });
}

// ---------------------------------------------------------------------------------------------
// A worker's attempt on pg-boss (store / chain tests).

/** The B2-02q handler over `files`, with recording ports. */
export function dailyHandler(
  db: Kysely<DB>,
  clock: FixedClock,
  queue: JobQueue,
  logger: DailyCheckScheduleLogger,
  files: () => readonly LedgerInvariantFile[],
): JobHandler {
  return createDailyCheckJob({
    db,
    clock,
    queue,
    logger,
    holds: recordingHolds(clock),
    autoSettlement: recordingSwitch(),
    invariants: {
      async load() {
        return files();
      },
    },
  });
}

/**
 * One attempt of the live job of (app, D): active, then the handler over `files`. Resolves to the
 * handler's error, or null when it ran to the end. The job is left active.
 */
export async function attempt(
  db: Kysely<DB>,
  clock: FixedClock,
  queue: JobQueue,
  logger: DailyCheckScheduleLogger,
  appId: string,
  day: string,
  files: () => readonly LedgerInvariantFile[],
): Promise<unknown> {
  const job = await liveJob(db, appId, day);
  await transition(db, job.id, 'active');
  const handler = dailyHandler(db, clock, queue, logger, files);
  try {
    await handler({
      id: job.id,
      queue: QUEUE,
      name: JOB,
      payload: job.payload ?? {},
      attempt: 1,
    });
    return null;
  } catch (error: unknown) {
    return error ?? new Error('rejected without a reason');
  }
}

/**
 * The attempt of (app, D) runs (to the end or not), then the queue judges it failed — it took
 * longer than ledger-check's expireInSeconds, or it threw — with no attempts left: the job is
 * failed and its copy waits in ledger-check.dead. Resolves to the handler's error or null.
 */
export async function attemptThenDead(
  db: Kysely<DB>,
  clock: FixedClock,
  queue: JobQueue,
  logger: DailyCheckScheduleLogger,
  appId: string,
  day: string,
  files: () => readonly LedgerInvariantFile[],
): Promise<unknown> {
  const job = await liveJob(db, appId, day);
  const error = await attempt(db, clock, queue, logger, appId, day, files);
  await failToDead(db, job.id);
  return error;
}
