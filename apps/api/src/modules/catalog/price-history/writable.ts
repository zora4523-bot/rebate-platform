// B1-17b: which union returns may be written to price_snapshot (BR-WATCH-05, BR-WATCH-19).
import type { PriceObservation, PriceSnapshotSkipReason } from './types.ts';

/**
 * null when the observation may be written; otherwise the first reason in the order of
 * PriceSnapshotSkipReason. The price anomaly check is union's isPriceAnomaly on the three amounts
 * and priceStatus (BR-PRICE-01), not a copy of it.
 */
export function priceSnapshotSkipReason(
  observation: PriceObservation,
): PriceSnapshotSkipReason | null {
  void observation;
  throw new Error('NotImplemented: priceSnapshotSkipReason');
}
