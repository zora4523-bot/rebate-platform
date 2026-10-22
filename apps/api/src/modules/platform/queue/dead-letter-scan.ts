import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../clock/index.ts';
import type { RootLogger } from '../logging/logger.ts';

/**
 * B1-01zzg: one read-only SQL scan of pgboss .dead queues. Log one error per nonempty
 * queue (order-sync.dead: per platform), with queue/platform/count, never job data.
 * Accept a transaction so the rule tests can enforce READ ONLY at PostgreSQL's boundary.
 * The worker's internal pg-boss schedule dead-letter-scan runs this every five minutes;
 * it must not add a dead queue to ENTRY_PLAN or fetch/complete/fail/replay dead jobs.
 */
export interface DeadLetterScanOptions {
  readonly db: Kysely<DB>;
  readonly logger: RootLogger;
  readonly clock: Clock;
}

export async function scanDeadLetters(options: DeadLetterScanOptions): Promise<void> {
  void options;
  throw new Error('NotImplemented: scanDeadLetters');
}
