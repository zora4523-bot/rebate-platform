// Dead letter scan (B1-01zzg; 规划/02 §7.1 死信不自动重放、只用于告警与排查, §11 失败告警, §13 5 分钟粒度).
// Every business queue <q> dead-letters into its own <q>.dead (catalog.ts). This module only COUNTS
// the jobs waiting there, with one read-only SQL statement, and logs one error line per nonempty
// dead letter queue (order-sync.dead: one per platform of the job data). It never fetches,
// completes, fails, changes or replays a dead job, and no entry plan works a dead letter queue
// (validation.ts). The worker runs it from an internal pg-boss schedule (runtime.ts).
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { Clock } from '../clock/index.ts';
import type { RootLogger } from '../logging/logger.ts';
import type { QueueSpec } from './types.ts';

/**
 * The worker's internal queue of the scan ticks. Not a catalog queue: no entry plan names it and
 * business code cannot send to it; the worker runtime creates it, schedules it and works it.
 */
export const DEAD_LETTER_SCAN_QUEUE = 'dead-letter-scan';

/** 规划/02 §13: the common 5-minute granularity, in UTC. */
export const DEAD_LETTER_SCAN_CRON = '*/5 * * * *';

/** The job data of every scheduled tick: the runtime's ordinary job envelope. */
export const DEAD_LETTER_SCAN_JOB = Object.freeze({
  name: 'dead_letter.scan',
  payload: Object.freeze({}),
});

/**
 * Settings of the scan queue. A failed tick is not retried and not dead-lettered: the next tick
 * five minutes later scans again. Short retention, since nothing ever looks a tick up.
 */
export const DEAD_LETTER_SCAN_SPEC: QueueSpec = Object.freeze({
  name: DEAD_LETTER_SCAN_QUEUE,
  policy: 'standard',
  retryLimit: 0,
  retryDelaySeconds: 1,
  retryBackoff: false,
  retryDelayMaxSeconds: null,
  expireInSeconds: 300,
  retentionSeconds: 3600,
  deleteAfterSeconds: 86_400,
  deadLetter: null,
});

/** The shared order-sync queue: its dead jobs are counted per platform of the job data. */
const PER_PLATFORM = 'order-sync.dead';

/**
 * The global dead letter queue of the catalog before B1-01zzg. No queue points at it any more,
 * but jobs dead-lettered before the migration may still wait there, so it is counted as well.
 */
const LEGACY_DEAD_LETTER = 'dead-letter';

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
  /**
   * Accepted for callers holding the process clock. The scan reads no time: it reports a
   * snapshot of PostgreSQL's job rows, so no field depends on a clock.
   */
  readonly clock?: Clock;
}

interface Row {
  queue: string;
  platform: string | null;
  count: number;
}

/**
 * Dead letter queues are found in SQL by name (every queue named `*.dead`, plus the legacy
 * `dead-letter`), so a queue added later is counted without changing this file. Only jobs still
 * waiting count (created, retry, active); an operator who completes or cancels a dead job silences
 * it. Log line: level error, message `dead_letter_jobs`, fields exactly { queue, count } or, for
 * order-sync.dead, { queue, platform, count } (no platform key when the job names none).
 */
export async function scanDeadLetters(options: DeadLetterScanOptions): Promise<void> {
  const { db, logger } = options;
  const { rows } = await sql<Row>`
    SELECT
      name AS queue,
      CASE WHEN name = ${PER_PLATFORM}
        THEN COALESCE(data ->> 'platform', data -> 'payload' ->> 'platform')
      END AS platform,
      count(*)::integer AS count
    FROM pgboss.job
    WHERE (name LIKE '%.dead' OR name = ${LEGACY_DEAD_LETTER})
      AND state IN ('created', 'retry', 'active')
    GROUP BY 1, 2
    ORDER BY 1, 2
  `.execute(db);
  for (const row of rows) {
    if (row.count <= 0) continue;
    logger.error(
      row.platform === null
        ? { queue: row.queue, count: row.count }
        : { queue: row.queue, platform: row.platform, count: row.count },
      'dead_letter_jobs',
    );
  }
}
