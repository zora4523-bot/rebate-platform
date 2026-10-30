// B2-04ze (D10-443): the settle queue of the worker entry (02 §11: `settle` 月结出账、批次执行;
// exclusive, worker only). One handler for the queue, dispatching on the job name:
// - `bill` (settle_jobs.job): payload { app_id, platform, accounting_date: D }, singletonKey
//   `bill:<app_id>:<platform>:<D>`; runs the bill job (bill/job.ts) for (app, platform) with the
//   nominal run_at = D 00:00 +08:00 (settleBillRunAt), the same on every delivery and re-seed of
//   that day. Seeded every day for every app × platform; on a day that is not settle.bill_day the
//   bill job itself answers not_due. An outcome of deferred (the day's asset snapshot is not ready)
//   fails the delivery, so the job is not completed and the queue / the next seed sends it again;
//   generated, duplicate and not_due complete it.
// - `batch_execute` (not in settle_jobs): payload { app_id, batch_id }, singletonKey
//   `batch_execute:<app_id>:<batch_id>`; runs the batch executor (batch/executor) once. Sent by the
//   scan for every batch that is CONFIRMED and due (IMMEDIATE, or SCHEDULED with scheduled_at ≤
//   now), not stopped by a switch (paused_by_switch_at null), and for every EXECUTING batch (SB9
//   take-over; the executor's own lock keeps one live executor). Every executor outcome completes
//   the delivery: progress lives in settle_batches / settle_batch_items, and the scan re-sends what
//   is still due.
// The seed and the scan decide from the queue (pgboss.job under the key) and the database
// (settle_jobs, settle_batches), never from process memory: a restarted worker decides the same.
// Time only from the injected Clock; days only through @couli/domain.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, JobHandler, JobQueue } from '../../platform/index.ts';
import type { BatchExecutor } from '../batch/executor/executor.ts';
import type { BillJob } from '../bill/job.ts';

/** The queue of the bill and the batch execution (platform/queue catalog, exclusive). */
export type SettleQueueName = 'settle';

/** The jobs of that queue. */
export type SettleJobName = 'bill' | 'batch_execute';

/** Payload of a `bill` job. */
export interface SettleBillJobPayload {
  readonly app_id: string;
  readonly platform: string;
  /** The +08:00 day D the bill job is seeded for (YYYY-MM-DD). */
  readonly accounting_date: string;
}

/** Payload of a `batch_execute` job. */
export interface SettleBatchExecuteJobPayload {
  readonly app_id: string;
  readonly batch_id: string;
}

export interface SettleBillJobInput {
  readonly appId: string;
  readonly platform: string;
  readonly accountingDate: string;
}

export interface SettleBatchExecuteJobInput {
  readonly appId: string;
  readonly batchId: string;
}

/** pino's two-argument shape. */
export interface SettleScheduleLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}

/** One queued or active bill run per (app, platform, D): `bill:<app_id>:<platform>:<D>`. */
export function settleBillJobKey(appId: string, platform: string, accountingDate: string): string {
  void appId;
  void platform;
  void accountingDate;
  throw new Error('NotImplemented: settleBillJobKey');
}

/** The nominal run_at of D's bill run: D 00:00 +08:00. A malformed or nonexistent D throws. */
export function settleBillRunAt(accountingDate: string): Date {
  void accountingDate;
  throw new Error('NotImplemented: settleBillRunAt');
}

/** One queued or active execution per batch: `batch_execute:<app_id>:<batch_id>`. */
export function settleBatchExecuteJobKey(appId: string, batchId: string): string {
  void appId;
  void batchId;
  throw new Error('NotImplemented: settleBatchExecuteJobKey');
}

/** Sends the `bill` job of (app, platform, D) on `trx` (null: outside a transaction), at once. */
export function scheduleSettleBill(
  queue: JobQueue,
  trx: Transaction<DB> | null,
  input: SettleBillJobInput,
): Promise<string | null> {
  void queue;
  void trx;
  void input;
  throw new Error('NotImplemented: scheduleSettleBill');
}

/** Sends the `batch_execute` job of the batch on `trx` (null: outside a transaction), at once. */
export function scheduleBatchExecute(
  queue: JobQueue,
  trx: Transaction<DB> | null,
  input: SettleBatchExecuteJobInput,
): Promise<string | null> {
  void queue;
  void trx;
  void input;
  throw new Error('NotImplemented: scheduleBatchExecute');
}

export interface SettleJobHandlerDependencies {
  readonly db: Kysely<DB>;
  readonly logger: SettleScheduleLogger;
  readonly bill: Pick<BillJob, 'run'>;
  readonly executor: Pick<BatchExecutor, 'run'>;
}

/**
 * The handler of queue settle. An unknown job name or a malformed payload is refused before a
 * port is called.
 */
export function createSettleJobHandler(dependencies: SettleJobHandlerDependencies): JobHandler {
  void dependencies;
  throw new Error('NotImplemented: createSettleJobHandler');
}

/**
 * The actual state of the bill run of (app, platform, D):
 * - 'done': settle_jobs holds a done row for (app, 'bill', platform, settleBillRunAt(D)), or a
 *   `bill` job of the key completed on queue settle;
 * - 'pending': not done, and a job of the key is queued (also delayed), active or waiting for a
 *   retry on queue settle (a copy in settle.dead does not count);
 * - 'absent': neither.
 */
export type SettleBillRunState = 'done' | 'pending' | 'absent';

export interface SettleRunStore {
  /** The state as stored now (no cache across calls, no process memory). */
  billStateOf(appId: string, platform: string, accountingDate: string): Promise<SettleBillRunState>;
}

export interface SettleBillSeedOptions {
  /** couli_app: the apps are the distinct app_id of app.orders. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly logger: SettleScheduleLogger;
  readonly runs: SettleRunStore;
  /** The platforms of every app (union REGISTERED_PLATFORMS). */
  readonly platforms: readonly string[];
}

/**
 * The daily seed (and heal) of the bill: for D = the +08:00 day of clock.now(), every app ×
 * platform whose run state is 'absent' gets its `bill` job (outside a transaction). A failure of
 * one does not stop the others; the first failure is rethrown after all of them.
 */
export function seedSettleBills(options: SettleBillSeedOptions): Promise<void> {
  void options;
  throw new Error('NotImplemented: seedSettleBills');
}

export interface SettleBatchScanOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly logger: SettleScheduleLogger;
}

/**
 * The scan of due batches (every app): one `batch_execute` send per batch that is CONFIRMED, due
 * by clock.now() and not stopped by a switch, or EXECUTING (see the file header). The queue's
 * singletonKey absorbs a batch already queued or running. A failed send does not stop the others;
 * the first failure is rethrown after all of them.
 */
export function scanDueBatches(options: SettleBatchScanOptions): Promise<void> {
  void options;
  throw new Error('NotImplemented: scanDueBatches');
}
