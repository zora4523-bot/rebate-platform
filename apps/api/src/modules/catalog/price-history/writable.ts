// B1-17b: which union returns may be written to price_snapshot (BR-WATCH-05, BR-WATCH-19).
import { isPriceAnomaly } from '../../union/index.ts';
import type { PriceObservation, PriceSnapshotSkipReason } from './types.ts';

/**
 * null when the observation may be written; otherwise the first reason in the order of
 * PriceSnapshotSkipReason. The price anomaly check is union's isPriceAnomaly on the three amounts
 * and priceStatus (BR-PRICE-01), not a copy of it.
 */
export function priceSnapshotSkipReason(
  observation: PriceObservation,
): PriceSnapshotSkipReason | null {
  if (observation.outcome !== 'ok') return 'upstream_failed';
  if (
    isPriceAnomaly({
      price_fen: observation.priceFen,
      coupon_fen: observation.couponFen,
      final_price_fen: observation.finalPriceFen,
      price_status: observation.priceStatus,
    })
  ) {
    return 'price_anomaly';
  }
  if (!observation.fresh) return 'not_fresh';
  if (observation.userScoped) return 'user_scoped';
  if (observation.sourceKind === 'convert') return 'convert';
  if (
    observation.platform === 'pdd' &&
    (typeof observation.goodsSignPlan !== 'string' || observation.goodsSignPlan.trim() === '')
  ) {
    return 'pdd_without_plan';
  }
  return null;
}
