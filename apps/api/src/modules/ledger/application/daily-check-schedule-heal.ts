// B2-02r: the heal of the daily ledger check chain (08 BR-FUND-19 每日 01:00 +08:00 对会计日 D−1 运行;
// task brief §9). Fixes the B2-02q heal, which skipped an app once this process had sent its D
// (memory `started`): after the `daily` job of (app, D) failed into ledger-check.dead the key was
// free again, yet nothing re-sent it and the self-rescheduling chain stopped silently.
//
// healDailyCheck (the worker timer's tick, replacing seedDailyCheck there): for every app with
// ledger accounts and D = dailyCheckDayOf(clock.now()):
// - reads the actual state of (app, D) from `runs` (the queue and the check's results, never
//   process memory, so a restart decides the same way);
// - 'absent' (never queued, or its jobs failed / were dead-lettered / cancelled, and not done):
//   sends the job of (app, D) again (scheduleDailyCheck, outside a transaction);
// - 'pending' (a job of the key is queued, active or waiting for a retry) or 'done': sends nothing;
// - not 'done' at or after dailyCheckOverdueAtMs(D) (D's run time D+1 01:00 +08:00 plus a grace the
//   implementation fixes, shorter than the rest of that day): one alert line per (app, D), durably
//   claimed through `runs`, so neither a later tick nor a restart repeats it. pino, level error,
//   fields { event: 'ledger_daily_check_overdue', app_id, accounting_date, ... } — no personal data.
// One app's failure does not stop the others; the first failure is rethrown after all apps.
// Time only from the injected Clock; D only through @couli/domain (via daily-check-schedule.ts).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, JobQueue } from '../../platform/index.ts';
import {
  dailyCheckDayOf,
  dailyCheckRunAtMs,
  scheduleDailyCheck,
  type DailyCheckScheduleLogger,
} from './daily-check-schedule.ts';

/**
 * The actual state of the run of (app, D):
 * - 'done': the run of (app, D) completed;
 * - 'pending': not done, and a `daily` job of its key is queued (also deferred), active or waiting
 *   for a retry on queue ledger-check;
 * - 'absent': neither — never queued, or its jobs failed (dead-lettered) or were cancelled. A copy
 *   waiting in ledger-check.dead does not make it pending.
 */
export type DailyCheckRunState = 'done' | 'pending' | 'absent';

/** The queue's and the results' state of the daily runs (infra/daily-check-run-store.ts). */
export interface DailyCheckRunStore {
  /** The state of (app, D) as stored now (no cache across calls). */
  stateOf(appId: string, accountingDate: string): Promise<DailyCheckRunState>;
  /**
   * Claims the one overdue alert of (app, D): true for the first claim ever (durable across
   * processes and restarts, one winner under concurrency), false afterwards.
   */
  claimOverdueAlert(appId: string, accountingDate: string): Promise<boolean>;
}

export interface DailyCheckHealOptions {
  /** couli_app: the apps with ledger accounts. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly logger: DailyCheckScheduleLogger;
  readonly runs: DailyCheckRunStore;
}

/**
 * The grace after D's run time before a not-done (app, D) is overdue: room for the run itself and
 * the queue's retries of a failed attempt, well inside D+1 (+08:00).
 */
const OVERDUE_GRACE_MS = 2 * 3_600_000;

/** The overdue alert line's event (ledger's alert lines carry `event`, B2-02p / B2-02q). */
const OVERDUE_EVENT = 'ledger_daily_check_overdue';

/**
 * Epoch milliseconds from which an (app, D) not done is overdue: D's run time (dailyCheckRunAtMs)
 * plus the grace; strictly after the run time and before the end of D+1 (+08:00).
 */
export function dailyCheckOverdueAtMs(accountingDate: string): number {
  return dailyCheckRunAtMs(accountingDate) + OVERDUE_GRACE_MS;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** One heal of the chain (see the header): re-sends absent runs, alerts overdue ones once. */
export async function healDailyCheck(options: DailyCheckHealOptions): Promise<void> {
  const { db, clock, queue, logger, runs } = options;
  const now = clock.now();
  const day = dailyCheckDayOf(now);
  const overdue = now.getTime() >= dailyCheckOverdueAtMs(day);
  const apps = await db
    .withSchema('app')
    .selectFrom('ledger_accounts')
    .select('app_id')
    .distinct()
    .orderBy('app_id')
    .execute();
  let failure: { readonly error: unknown } | null = null;
  for (const { app_id: appId } of apps) {
    try {
      const state = await runs.stateOf(appId, day);
      // The alert first: a failing send below must not swallow it.
      if (state !== 'done' && overdue && (await runs.claimOverdueAlert(appId, day))) {
        logger.error(
          { event: OVERDUE_EVENT, app_id: appId, accounting_date: day, state },
          'ledger daily check overdue',
        );
      }
      if (state !== 'absent') continue;
      await scheduleDailyCheck(queue, null, appId, day, now);
      logger.info({ app_id: appId, accounting_date: day }, 'ledger_daily_check_healed');
    } catch (error: unknown) {
      failure ??= { error };
      logger.warn(
        { app_id: appId, accounting_date: day, error_name: errorName(error) },
        'ledger_daily_check_heal_app_failed',
      );
    }
  }
  if (failure !== null) throw failure.error;
}
