// B2-02r: DailyCheckRunStore over PostgreSQL (couli_app). stateOf reads the `daily` jobs of queue
// ledger-check under singletonKey daily:<app_id>:<D> (pgboss.job, plain read-only SQL; ADR-0001 §3
// 排查用普通 SQL) together with the check's own record of a completed run; ledger-check.dead copies
// are not pending. claimOverdueAlert stores the claim durably (one winner under concurrency). The
// store holds no state in memory: a new instance (a restarted worker) answers the same.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { DailyCheckRunStore } from '../application/daily-check-schedule-heal.ts';

export function createDailyCheckRunStore(db: Kysely<DB>): DailyCheckRunStore {
  void db;
  throw new Error('NotImplemented: createDailyCheckRunStore');
}
