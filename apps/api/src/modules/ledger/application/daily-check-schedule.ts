// B2-02q: the daily chain of the ledger check (08 BR-FUND-19: 每日 01:00 +08:00 对会计日 D−1 运行;
// precedents payment bill.recon (B2-15m) and payout-recon (B2-07c)).
//
// Queue `ledger-check` (platform/queue catalog and worker plan, exclusive), job `daily`, payload
// { app_id, accounting_date: D }, singletonKey `daily:<app_id>:<D>` (dailyCheckJobKey). The run of
// D is due at D+1 01:00 +08:00 (dailyCheckRunAtMs), at once when that time has passed.
// - createDailyCheckJob: the handler of `daily`: runs createDailyCheck for (app, D) — D is the
//   payload's, never the clock's — hands every difference with its invariant file to the B2-02p
//   execution step, then enqueues D+1 on a transaction (scheduleDailyCheck) so the chain goes on
//   day by day; a failed run throws (the queue retries; reruns are idempotent).
// - seedDailyCheck: the chain's start and heal (worker entry only, LedgerDailyCheckModule): for
//   every app with ledger accounts, one job for D−1 of the clock's +08:00 day (dailyCheckDayOf);
//   `started` remembers the day each app was sent for by this process.
// D only through @couli/domain (accountingDate / chinaDayRange); time only from the injected Clock.
import type { DB } from '@couli/db';
import { accountingDate, chinaDayRange } from '@couli/domain';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, JobHandler, JobQueue } from '../../platform/index.ts';
import { createDailyCheck, type DailyCheckLogger } from './daily-check.ts';
import {
  createDailyCheckExecutor,
  type AutoSettlementSwitch,
  type LedgerMismatchHolds,
} from './daily-check-execute.ts';
import { recordDailyCheckDone } from './daily-check-schedule-done.ts';
import type { LedgerInvariantSource } from './daily-check-types.ts';
import { LedgerError } from './errors.ts';

/** The queue of the daily check (platform/queue catalog and worker plan). */
export type DailyCheckQueue = 'ledger-check';

/** The job of one (app, D) run on that queue. */
export type DailyCheckJobName = 'daily';

/** Payload of a `daily` job. */
export interface DailyCheckJobPayload {
  readonly app_id: string;
  /** The checked accounting day D (YYYY-MM-DD, +08:00). */
  readonly accounting_date: string;
}

/** pino's two-argument shape (the runner's and the execution step's warn / error, plus info). */
export interface DailyCheckScheduleLogger extends DailyCheckLogger {
  info(fields: Record<string, unknown>, message?: string): void;
}

const QUEUE: DailyCheckQueue = 'ledger-check';
const JOB: DailyCheckJobName = 'daily';
const MS_PER_DAY = 86_400_000;
/** BR-FUND-19: the run of D starts at D+1 01:00 +08:00. */
const RUN_AFTER_DAY_END_MS = 3_600_000;

/** chinaDayRange of a strict, existing YYYY-MM-DD; anything else is INVALID_INPUT. */
function dayRange(day: string): { start: string; end: string } {
  try {
    return chinaDayRange(day);
  } catch (error) {
    throw new LedgerError('INVALID_INPUT', `invalid accounting date ${JSON.stringify(day)}`, {
      cause: error,
    });
  }
}

function validInstant(now: Date): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new LedgerError('INVALID_INPUT', 'now must be a valid Date');
  }
}

/** One queued or active run per (app, D): `daily:<app_id>:<D>`. */
export function dailyCheckJobKey(appId: string, accountingDate: string): string {
  return `daily:${appId}:${accountingDate}`;
}

/** Epoch milliseconds of the run of D: D+1 01:00 +08:00. */
export function dailyCheckRunAtMs(accountingDate: string): number {
  return Date.parse(dayRange(accountingDate).end) + RUN_AFTER_DAY_END_MS;
}

/** The accounting day after D. */
export function dailyCheckDayAfter(accountingDate: string): string {
  // The end of D is the next day's +08:00 midnight, `YYYY-MM-DDT00:00:00+08:00`.
  return dayRange(accountingDate).end.slice(0, 10);
}

/** D−1 of the +08:00 accounting day `now` is in (the day that day's 01:00 run checks). */
export function dailyCheckDayOf(now: Date): string {
  validInstant(now);
  // +08:00 has no daylight saving: one day back is exactly 24 hours (no `new Date(`).
  const before = structuredClone(now);
  before.setTime(now.getTime() - MS_PER_DAY);
  return accountingDate(before);
}

/**
 * Sends the `daily` job of (app, D) on `trx` (null: outside a transaction), due at D's run time
 * (delay 0 when it has passed). A run queued or active under the same key absorbs it.
 */
export function scheduleDailyCheck(
  queue: JobQueue,
  trx: Transaction<DB> | null,
  appId: string,
  accountingDate: string,
  now: Date,
): Promise<string | null> {
  validInstant(now);
  const dueMs = dailyCheckRunAtMs(accountingDate);
  // Never early: a fraction of a second left counts as a whole second.
  const delaySeconds = Math.max(0, Math.ceil((dueMs - now.getTime()) / 1000));
  const payload: DailyCheckJobPayload = { app_id: appId, accounting_date: accountingDate };
  return queue.send(
    QUEUE,
    JOB,
    { ...payload },
    { trx, singletonKey: dailyCheckJobKey(appId, accountingDate), delaySeconds },
  );
}

export interface DailyCheckSeedOptions {
  /** couli_app: the apps with ledger accounts. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly logger: DailyCheckScheduleLogger;
  /** The worker's memory (one per process): app → the D it was last sent for. */
  readonly started?: Map<string, string>;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * The chain's start and heal: one job of D−1 per app not yet started for that D by this process.
 * A failure of one app does not stop the others; the first failure is rethrown after all apps.
 */
export async function seedDailyCheck(options: DailyCheckSeedOptions): Promise<void> {
  const { db, clock, queue, logger } = options;
  const now = clock.now();
  const day = dailyCheckDayOf(now);
  const apps = await db
    .withSchema('app')
    .selectFrom('ledger_accounts')
    .select('app_id')
    .distinct()
    .orderBy('app_id')
    .execute();
  let failure: { readonly error: unknown } | null = null;
  for (const { app_id: appId } of apps) {
    if (options.started?.get(appId) === day) continue;
    try {
      await scheduleDailyCheck(queue, null, appId, day, now);
      options.started?.set(appId, day);
      logger.info({ app_id: appId, accounting_date: day }, 'ledger_daily_check_seeded');
    } catch (error: unknown) {
      failure ??= { error };
      logger.warn(
        { app_id: appId, accounting_date: day, error_name: errorName(error) },
        'ledger_daily_check_seed_failed',
      );
    }
  }
  if (failure !== null) throw failure.error;
}

export interface DailyCheckJobDependencies {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly logger: DailyCheckScheduleLogger;
  /** payout's hold port (B2-02p LedgerMismatchHolds), assembled by app.module. */
  readonly holds: LedgerMismatchHolds;
  /** content's switch port (B2-02p AutoSettlementSwitch), assembled by app.module. */
  readonly autoSettlement: AutoSettlementSwitch;
  /** Omitted: db/invariants/ledger/*.sql (createDailyCheck's default source). */
  readonly invariants?: LedgerInvariantSource;
}

/** The payload's (app, D); anything else is refused before a statement runs. */
function payloadOf(payload: Record<string, unknown>): DailyCheckJobPayload {
  const appId = payload['app_id'];
  const day = payload['accounting_date'];
  if (typeof appId !== 'string' || appId === '') {
    throw new LedgerError('INVALID_INPUT', 'daily check job: app_id must be a non-empty string');
  }
  if (typeof day !== 'string') {
    throw new LedgerError('INVALID_INPUT', 'daily check job: accounting_date must be text');
  }
  dayRange(day);
  return { app_id: appId, accounting_date: day };
}

/** The handler of queue ledger-check (job `daily`). */
export function createDailyCheckJob(dependencies: DailyCheckJobDependencies): JobHandler {
  const { db, clock, queue, logger, holds, autoSettlement } = dependencies;
  const runner = createDailyCheck({
    clock,
    logger,
    ...(dependencies.invariants === undefined ? {} : { invariants: dependencies.invariants }),
  });
  const executor = createDailyCheckExecutor({ clock, logger, holds, autoSettlement });
  return async (job) => {
    if (job.name !== JOB) {
      throw new LedgerError('INVALID_INPUT', `unknown job ${JSON.stringify(job.name)} on ${QUEUE}`);
    }
    const { app_id: appId, accounting_date: day } = payloadOf(job.payload);
    // D is the payload's, never the clock's: a late or replayed run checks its own day.
    const result = await runner.runDailyCheck(db, { appId, accountingDate: day });
    const execution = await executor.execute(db, {
      accountingDate: day,
      differences: result.filedDifferences,
    });
    const next = dailyCheckDayAfter(day);
    // B2-02s: D+1 and the completion record of (app, D) on one transaction — both or neither.
    await db.transaction().execute(async (trx) => {
      const now = clock.now();
      await scheduleDailyCheck(queue, trx, appId, next, now);
      await recordDailyCheckDone(trx, appId, day, now);
    });
    logger.info(
      {
        app_id: appId,
        accounting_date: day,
        differences: result.filedDifferences.length,
        recon_diffs: execution.reconDiffs.length,
        auto_settlement_off: execution.autoSettlementOff.length,
        next_accounting_date: next,
      },
      'ledger_daily_check_done',
    );
  };
}
