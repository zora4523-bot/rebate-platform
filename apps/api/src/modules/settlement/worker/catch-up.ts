// B2-04zg (D10-476): the catch-up of the monthly bill on the worker entry (08 BR-FUND-04 ③,
// BR-FUND-18). Skeleton: every function throws NotImplemented.
// - settleBillCatchUpPeriod: the latest bill day D* on or before a +08:00 day (settle.bill_day,
//   22–28) and its bill month M = the month before D*'s month.
// - createSettleCatchUpStore: whether the bill of (app, platform, D*) is generated, still queued or
//   neither, read from settle_jobs, settle_bills and pgboss.job (no process memory).
// - seedSettleBillCatchUp: on every tick of the module's timer (the first one after start is the
//   worker's self-heal), for every app × platform whose bill month M is not generated and has no
//   live job, sends D*'s `bill` job again (payload and singletonKey of the daily seed). The bill job
//   keeps bill_id = M and judges the asset snapshot on the day it runs. Earlier periods are never
//   looked at. Time only from the injected Clock.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, JobQueue } from '../../platform/index.ts';
import type { SettlementConfigReader } from './ports.ts';
import type { SettleScheduleLogger } from './schedule.ts';

/** The period the catch-up looks back at. */
export interface SettleBillCatchUpPeriod {
  /** D*: the latest bill day on or before the given day (YYYY-MM-DD, +08:00). */
  readonly accountingDate: string;
  /** M: the bill month of D* (YYYY-MM, the month before D*'s month). */
  readonly billId: string;
}

/**
 * D* and M for the +08:00 day `today` and settle.bill_day `billDay` (an integer 22–28). A malformed
 * or nonexistent day, or a bill day outside 22–28, throws.
 */
export function settleBillCatchUpPeriod(today: string, billDay: number): SettleBillCatchUpPeriod {
  void today;
  void billDay;
  throw new Error('NotImplemented: settleBillCatchUpPeriod');
}

/**
 * The catch-up state of the bill of (app, platform, D*):
 * - 'generated': settle_jobs holds a done row for (app, 'bill', platform, D* 00:00 +08:00), or
 *   settle_bills holds the bill month M of D* generated with the platform in platform_order_counts;
 * - 'pending': not generated, and a `bill` job under bill:<app_id>:<platform>:<D*> is queued (also
 *   delayed), active or waiting for a retry on queue settle;
 * - 'absent': neither. A completed job does not count as generated (deferred and not_due complete
 *   the delivery too), nor does a failed settle_jobs row, a cancelled job or a settle.dead copy.
 */
export type SettleBillCatchUpState = 'generated' | 'pending' | 'absent';

export interface SettleCatchUpStore {
  /** The state as stored now (no cache across calls, no process memory). */
  billCatchUpStateOf(
    appId: string,
    platform: string,
    accountingDate: string,
  ): Promise<SettleBillCatchUpState>;
}

/** SettleCatchUpStore over PostgreSQL (couli_app). */
export function createSettleCatchUpStore(db: Kysely<DB>): SettleCatchUpStore {
  void db;
  throw new Error('NotImplemented: createSettleCatchUpStore');
}

export interface SettleBillCatchUpOptions {
  /** couli_app: the apps are the distinct app_id of app.orders. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly logger: SettleScheduleLogger;
  readonly runs: SettleCatchUpStore;
  /** The platforms of every app (union REGISTERED_PLATFORMS). */
  readonly platforms: readonly string[];
  /** content's reader: settle.bill_day of each app (unset: 24). */
  readonly config: SettlementConfigReader;
}

/**
 * The catch-up: for every app, D* of the +08:00 day of clock.now() under the app's settle.bill_day;
 * every platform whose state is 'absent' gets D*'s `bill` job (outside a transaction). A failure of
 * one app (its configuration or a send) does not stop the others; the first failure is rethrown
 * after all of them.
 */
export async function seedSettleBillCatchUp(options: SettleBillCatchUpOptions): Promise<void> {
  void options;
  throw new Error('NotImplemented: seedSettleBillCatchUp');
}
