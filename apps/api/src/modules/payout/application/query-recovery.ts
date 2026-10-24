// B2-06e: crash recovery of the query chain (规划/08 BR-WDR-14; 规划/12 §5.4). scan(handle, now)
// looks at every app's withdrawals in PAYING with needs_manual = false that have a kind=transfer
// attempt (any result; T = the earliest one's `at`):
//   manualDue(schedule, T, now) → CAS needs_manual = true (row_version + 1, on attemptsDb: only
//     couli_payout may write it), logger.warn({ withdrawal_id, out_biz_no, point },
//     'payout_needs_manual'), no job; counted in `manual`.
//   otherwise n = the first point with T + queryPointOffsetSeconds(n) > now and
//     queue.send('payout', 'query', { withdrawal_id, execute_seq, app_id, point: n },
//       { trx, singletonKey: `${withdrawal_id}:${execute_seq}:query:${n}`,
//         delaySeconds: T + offset(n) − now })
//     a send that returns null (a queued or active job of that key already exists) is not
//     counted; one that returns an id is counted in `enqueued`.
// Withdrawals in other states, with needs_manual = true or without a transfer attempt are not
// touched. Returns { scanned (the withdrawals examined), enqueued, manual }. The process start and
// the hourly call are wired by B2-06f. payout.enabled / payout.queue_paused do not matter.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { JobQueue } from '../../platform/index.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';

export interface QueryRecoveryLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface QueryRecoveryOptions {
  /** couli_payout handle: withdrawals.needs_manual. */
  readonly attemptsDb: Kysely<DB>;
  /** content's configuration reader (payout.query_schedule), direct PG. */
  readonly config: PayoutConfigPort;
  readonly queue: JobQueue;
  readonly logger: QueryRecoveryLogger;
}

export interface QueryRecoveryResult {
  readonly scanned: number;
  readonly enqueued: number;
  readonly manual: number;
}

export interface QueryRecovery {
  /** `handle`: the business handle the withdrawals are read and the jobs are enqueued with. */
  scan(handle: Kysely<DB>, now: Date): Promise<QueryRecoveryResult>;
}

export function createQueryRecovery(options: QueryRecoveryOptions): QueryRecovery {
  void options;
  throw new Error('NotImplemented: createQueryRecovery');
}
