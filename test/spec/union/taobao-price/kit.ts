import { expect } from 'vitest';
import type {
  PriceAnomalyReason,
  TaobaoPriceInput,
  TaobaoPriceResult,
} from '../../../../apps/api/src/modules/union/index.ts';

// Synthetic domain fen values, deliberately not a platform response or recording.
export const now = 1_900_000_000_000;
export const example: TaobaoPriceInput = {
  discount_fen: 3990n,
  promotion_final_fen: 2365n,
  promotions: [
    { title: '商品券', amount_fen: 500n, id: 'demo-coupon' },
    { title: '百亿补贴', amount_fen: 1000n },
    { title: '88VIP9.5折', amount_fen: 125n },
  ],
};

export function expectPrice(
  result: TaobaoPriceResult,
  price: bigint,
  coupon: bigint,
  final: bigint,
  ids?: string,
): void {
  expect(result).toMatchObject({
    price_fen: price,
    coupon_fen: coupon,
    final_price_fen: final,
    price_status: 'ok',
  });
  expect(Object.hasOwn(result, 'price_anomaly_reason')).toBe(false);
  if (ids === undefined) {
    expect(Object.hasOwn(result, 'coupon_ids')).toBe(false);
  } else {
    expect(result.coupon_ids).toBe(ids);
  }
}

export function expectAnomaly(result: TaobaoPriceResult, reason: PriceAnomalyReason): void {
  expect(result).toMatchObject({
    price_fen: 0n,
    coupon_fen: 0n,
    final_price_fen: 0n,
    price_status: 'anomaly',
    price_anomaly_reason: reason,
  });
}

export function expectCalcDiff(result: TaobaoPriceResult, reason: PriceAnomalyReason): void {
  expectAnomaly(result, reason);
  expect(result.warnings).toContainEqual({ code: 'PRICE_CALC_DIFF' });
}
