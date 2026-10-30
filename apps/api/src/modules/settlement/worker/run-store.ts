// B2-04ze (D10-443): SettleRunStore over PostgreSQL (couli_app). billStateOf reads the `bill` jobs of
// queue settle under singletonKey bill:<app_id>:<platform>:<D> (pgboss.job, plain read-only SQL;
// ADR-0001 §3) and the settle_jobs row of (app, 'bill', platform, settleBillRunAt(D)). A done
// settle_jobs row is done whatever the queue holds (an attempt judged expired may have finished);
// a completed job is done (the handler completes only generated / duplicate / not_due); settle.dead
// copies are not pending (another queue name). Nothing is kept in memory.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { SettleRunStore } from './schedule.ts';

export function createSettleRunStore(db: Kysely<DB>): SettleRunStore {
  void db;
  throw new Error('NotImplemented: createSettleRunStore');
}
