// B1-17b: the after-response recorder of price_snapshot (BR-WATCH-19 (1): written asynchronously
// after the response, a failed write is only counted, never retried, and never affects the API).
import type {
  PriceSnapshotRecorder,
  PriceSnapshotRecorderOptions,
  PriceSnapshotWrite,
} from './types.ts';
import { priceSnapshotSkipReason } from './writable.ts';

const DEFAULT_TOUCH_INTERVAL_MINUTES = 10;
const TOUCH_INTERVAL_KEY = 'price_snapshot.touch_min_interval_minutes';

/**
 * See PriceSnapshotRecorder. Configuration key price_snapshot.touch_min_interval_minutes, read
 * per observation through options.config.configValue(appId, key); default 10 (08 09_WATCH
 * parameter table) when missing, not a positive safe integer, or the read fails.
 */
export function createPriceSnapshotRecorder(
  options: PriceSnapshotRecorderOptions,
): PriceSnapshotRecorder {
  const pending = new Set<Promise<void>>();
  let failures = 0;

  function failed(): void {
    failures += 1;
    try {
      // Do not log the input or the DB error: either may contain user identifiers.
      options.logger.warn({ code: 'PRICE_SNAPSHOT_WRITE_FAILED' });
    } catch {
      // A broken log sink must not turn a background failure into a request failure.
    }
  }

  async function write(input: PriceSnapshotWrite): Promise<void> {
    let interval = DEFAULT_TOUCH_INTERVAL_MINUTES;
    try {
      const entry = await options.config.configValue(input.appId, TOUCH_INTERVAL_KEY);
      const value = entry?.value;
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
        interval = value;
      }
    } catch {
      // Configuration failure uses the documented default; it is not a write failure.
    }
    await options.store.write({ ...input, touchMinIntervalMinutes: interval });
  }

  return {
    record(observation): void {
      try {
        if (priceSnapshotSkipReason(observation) !== null) return;
        // Capture the instant and whitelist fields before handing off. Later caller mutations
        // cannot change the observation, and extra user fields are never retained by the task.
        const input: PriceSnapshotWrite = {
          appId: observation.appId,
          platform: observation.platform,
          productKey: observation.productKey,
          skuKey: observation.skuKey,
          sourceKind: observation.sourceKind,
          values: {
            priceFen: observation.priceFen,
            couponFen: observation.couponFen,
            finalPriceFen: observation.finalPriceFen,
            inStock: observation.inStock,
          },
          goodsSignPlan: observation.platform === 'pdd' ? observation.goodsSignPlan : null,
          observedAt: structuredClone(options.clock.now()),
          touchMinIntervalMinutes: DEFAULT_TOUCH_INTERVAL_MINUTES,
        };
        // The caller invokes record after sending the response. Neither config nor store runs
        // on this synchronous stack; failures settle the task without scheduling a retry.
        const task = Promise.resolve()
          .then(() => write(input))
          .catch(failed)
          .then(() => {
            pending.delete(task);
          });
        pending.add(task);
      } catch {
        failed();
      }
    },
    async drain(): Promise<void> {
      await Promise.all([...pending]);
    },
    failureCount(): number {
      return failures;
    },
  };
}
