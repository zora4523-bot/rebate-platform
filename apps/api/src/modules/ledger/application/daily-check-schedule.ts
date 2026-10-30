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
// B2-02q test phase: NotImplemented skeleton only.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, JobHandler, JobQueue } from '../../platform/index.ts';
import type { DailyCheckLogger } from './daily-check.ts';
import type { AutoSettlementSwitch, LedgerMismatchHolds } from './daily-check-execute.ts';
import type { LedgerInvariantSource } from './daily-check-types.ts';

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

/** One queued or active run per (app, D): `daily:<app_id>:<D>`. */
export function dailyCheckJobKey(appId: string, accountingDate: string): string {
  void appId;
  void accountingDate;
  throw new Error('NotImplemented: dailyCheckJobKey');
}

/** Epoch milliseconds of the run of D: D+1 01:00 +08:00. */
export function dailyCheckRunAtMs(accountingDate: string): number {
  void accountingDate;
  throw new Error('NotImplemented: dailyCheckRunAtMs');
}

/** The accounting day after D. */
export function dailyCheckDayAfter(accountingDate: string): string {
  void accountingDate;
  throw new Error('NotImplemented: dailyCheckDayAfter');
}

/** D−1 of the +08:00 accounting day `now` is in (the day that day's 01:00 run checks). */
export function dailyCheckDayOf(now: Date): string {
  void now;
  throw new Error('NotImplemented: dailyCheckDayOf');
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
  void queue;
  void trx;
  void appId;
  void accountingDate;
  void now;
  throw new Error('NotImplemented: scheduleDailyCheck');
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

/**
 * The chain's start and heal: one job of D−1 per app not yet started for that D by this process.
 * A failure of one app does not stop the others; the first failure is rethrown after all apps.
 */
export function seedDailyCheck(options: DailyCheckSeedOptions): Promise<void> {
  void options;
  throw new Error('NotImplemented: seedDailyCheck');
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

/** The handler of queue ledger-check (job `daily`). */
export function createDailyCheckJob(dependencies: DailyCheckJobDependencies): JobHandler {
  void dependencies;
  throw new Error('NotImplemented: createDailyCheckJob');
}
