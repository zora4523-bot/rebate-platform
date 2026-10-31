// 京东商品接口（jd.union.open.goods.query，B1-04zc）的选券、价格与 DTO 映射。
// 规则测试：test/spec/union/jd-goods/**。现在只是 NotImplemented 骨架。
import type { PriceAnomalyReason } from '../../domain/taobao-price.ts';
import type { UnionItemDetail } from '../../domain/types.ts';
import type { JdProductKeyMode } from './orders.ts';
import type { JdWarning } from './response.ts';

/** 一页商品报文的取数信息；warn 收 PRICE_ANOMALY、PRICE_CALC_DIFF。 */
export interface JdGoodsPage {
  readonly now: Date;
  readonly productKeyMode: JdProductKeyMode;
  readonly warn: ((event: JdWarning) => void) | undefined;
}

/** 选中的券，整数分。 */
export interface JdCouponChoice {
  readonly discount_fen: bigint;
  readonly quota_fen: bigint;
}

/** 价格数据异常；不带报文内容。 */
export interface JdPriceAnomalyWarning extends JdWarning {
  readonly code: 'PRICE_ANOMALY';
  readonly item_id: string | null;
  readonly reason: PriceAnomalyReason;
}

/** 自算券后价与 lowestCouponPrice 相差 ≥ 1 分：只带商品标识与两个分值。 */
export interface JdPriceDiffWarning extends JdWarning {
  readonly code: 'PRICE_CALC_DIFF';
  readonly item_id: string;
  readonly final_price_fen: bigint;
  readonly lowest_coupon_price_fen: bigint;
}

/** 从 couponInfo.couponList 选券（BR-PRICE-01）；一张都不合格为 null。 */
export function pickJdCoupon(
  coupons: unknown,
  priceFen: bigint,
  nowMs: number,
): JdCouponChoice | null {
  void coupons;
  void priceFen;
  void nowMs;
  throw new Error('NotImplemented: pickJdCoupon');
}

/** 一条商品（内层数字都是 JdRawNumber）→ 统一 DTO；价格或佣金不合格出 price_status='anomaly'。 */
export function mapJdGoods(input: unknown, page: JdGoodsPage): UnionItemDetail {
  void input;
  void page;
  throw new Error('NotImplemented: mapJdGoods');
}
