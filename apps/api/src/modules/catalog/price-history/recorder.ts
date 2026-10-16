// B1-17b: the after-response recorder of price_snapshot (BR-WATCH-19 (1): written asynchronously
// after the response, a failed write is only counted, never retried, and never affects the API).
import type { PriceSnapshotRecorder, PriceSnapshotRecorderOptions } from './types.ts';

/**
 * See PriceSnapshotRecorder. Configuration key price_snapshot.touch_min_interval_minutes, read
 * per observation through options.config.configValue(appId, key); default 10 (08 09_WATCH
 * parameter table) when missing, not a positive safe integer, or the read fails.
 */
export function createPriceSnapshotRecorder(
  options: PriceSnapshotRecorderOptions,
): PriceSnapshotRecorder {
  void options;
  throw new Error('NotImplemented: createPriceSnapshotRecorder');
}
