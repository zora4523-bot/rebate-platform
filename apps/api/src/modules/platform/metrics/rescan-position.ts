// The worker's rescan position gauge (B1-01zzr; D10-747 / D10-765 / D10-766 A):
// couli_sync_rescan_position_seconds{app_id, platform, query_kind}. A rescan cursor (query_kind
// 'rescan') is a scan position, not a watermark (orders/domain/sync-window.ts rescanStep), so it is
// left out of couli_sync_watermark_lag_seconds and exported here instead: per (app_id, platform,
// query_kind) of the rescan streams, now − min(cursor_at) in whole seconds, never negative; no
// rescan stream, no series. Only the worker exports it, from the same registry and the same
// collect as the business gauges; no alert reads it. "now" is the injected Clock only.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../clock/index.ts';
import type { WorkerMetricsSnapshot } from './collect.ts';

/** The query_kind values that are no sync stream: never counted in the watermark lag. */
export type NonSyncQueryKind = 'rescan' | 'rights' | 'manual';

/** One series of couli_sync_rescan_position_seconds. */
export interface RescanPositionSample {
  readonly appId: string;
  readonly platform: string;
  readonly queryKind: string;
  /** now − min(cursor_at) of the group's streams, in whole seconds (rounded down), at least 0. */
  readonly seconds: number;
}

/** Every rescan position series of one scrape. */
export type RescanPositionSnapshot = readonly RescanPositionSample[];

/**
 * What the worker's collect hands to the registry: the frozen B1-01zzh snapshot plus the rescan
 * positions, optional so a bare WorkerMetricsSnapshot still renders (no rescan series).
 */
export interface WorkerCollection extends WorkerMetricsSnapshot {
  readonly rescanPositionSeconds?: RescanPositionSnapshot;
}

/** The rescan positions at the injected clock's now (read-only SQL over app.sync_cursors). */
export function collectRescanPositions(
  db: Kysely<DB>,
  clock: Clock,
): Promise<RescanPositionSnapshot> {
  void db;
  void clock;
  throw new Error('NotImplemented: collectRescanPositions');
}
