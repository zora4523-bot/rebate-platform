// B2-04ze (D10-443): SettleRunStore over PostgreSQL (couli_app). billStateOf reads the `bill` jobs of
// queue settle under singletonKey bill:<app_id>:<platform>:<D> (pgboss.job, plain read-only SQL;
// ADR-0001 §3) and the settle_jobs row of (app, 'bill', platform, settleBillRunAt(D)). A done
// settle_jobs row is done whatever the queue holds (an attempt judged expired may have finished);
// a completed job is done (the handler completes only generated / duplicate / not_due); settle.dead
// copies are not pending (another queue name). Nothing is kept in memory.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { settleBillJobKey, settleBillRunAt, type SettleRunStore } from './schedule.ts';

const QUEUE = 'settle';
const JOB = 'bill';

interface StateRow {
  readonly done: boolean;
  readonly pending: boolean;
}

export function createSettleRunStore(db: Kysely<DB>): SettleRunStore {
  return {
    async billStateOf(appId, platform, accountingDate) {
      if (appId === '' || platform === '') {
        throw new Error('settle run store: app_id and platform must be nonempty');
      }
      // Refuses a malformed or nonexistent D before a statement runs.
      const runAt = settleBillRunAt(accountingDate);
      const key = settleBillJobKey(appId, platform, accountingDate);
      const { rows } = await sql<StateRow>`
        SELECT
          (EXISTS (
            SELECT 1 FROM app.settle_jobs
            WHERE app_id = ${appId} AND job = ${JOB} AND platform = ${platform}
              AND run_at = ${runAt} AND status = 'done'
          ) OR COALESCE(bool_or(state = 'completed'), false)) AS done,
          COALESCE(bool_or(state IN ('created', 'retry', 'active')), false) AS pending
        FROM pgboss.job
        WHERE name = ${QUEUE} AND singleton_key = ${key}
      `.execute(db);
      const row = rows[0];
      if (row?.done === true) return 'done';
      if (row?.pending === true) return 'pending';
      return 'absent';
    },
  };
}
