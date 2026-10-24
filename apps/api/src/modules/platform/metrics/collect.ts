// Whole-database worker metrics (B1-01zzh; 规划/02 §11, §13; ADR-0001 §4.2 #14). Read-only SQL over
// pgboss.job and app.sync_cursors; "now" is the injected Clock only. Only the worker exports them.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../clock/index.ts';

/** One scrape's values, keyed by the label value (queue name or platform). */
export interface WorkerMetricsSnapshot {
  /** Every queue (business queues and their `<q>.dead`): jobs in state failed. */
  readonly queueFailed: Readonly<Record<string, number>>;
  /** Every `<q>.dead` queue: jobs still waiting there (state created or retry). */
  readonly deadLetters: Readonly<Record<string, number>>;
  /** Every business queue: jobs in state created whose start_after is at or before now. */
  readonly backlog: Readonly<Record<string, number>>;
  /** Every `evt.*` queue: max(now - start_after) in seconds of its created, due jobs; 0 if none. */
  readonly oldestDueEvtAgeSeconds: Readonly<Record<string, number>>;
  /** Per platform with a cursor: now - min(cursor_at) in whole seconds. */
  readonly syncWatermarkLagSeconds: Readonly<Record<string, number>>;
}

export function collectWorkerMetrics(
  db: Kysely<DB>,
  clock: Clock,
): Promise<WorkerMetricsSnapshot> {
  void db;
  void clock;
  throw new Error('NotImplemented: collectWorkerMetrics');
}
