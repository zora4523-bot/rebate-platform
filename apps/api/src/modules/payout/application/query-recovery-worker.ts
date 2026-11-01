// B2-06i: the payout process's timer around the query chain's crash recovery (规划/08 BR-WDR-14;
// query-recovery.ts): one round at once, then one every hour. Skeleton only; the rule tests are in
// test/spec/payout/query-recovery-wiring/.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { QueryRecovery, QueryRecoveryLogger } from './query-recovery.ts';

export interface QueryRecoveryWorkerOptions {
  readonly recovery: Pick<QueryRecovery, 'scan'>;
  /** The handle handed to scan. */
  readonly db: Kysely<DB>;
  /** Every round reads clock.now() afresh. */
  readonly clock: Clock;
  readonly logger: QueryRecoveryLogger;
}

export interface QueryRecoveryWorker {
  stop(): Promise<void>;
}

export function startQueryRecoveryWorker(options: QueryRecoveryWorkerOptions): QueryRecoveryWorker {
  void options;
  throw new Error('NotImplemented: startQueryRecoveryWorker');
}
