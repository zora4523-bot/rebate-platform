// 京东订单行（jd.union.open.order.row.query）的 DTO 映射骨架（B1-04zb）。
// 规则测试：test/spec/union/jd-orders/**。实现时常量、时间窗与翻页也落在这里。
import type { UnionOrder, UnionOrderNeutralFields } from '../../domain/types.ts';

/** BR-PROD-03 / 05：订单的商品键取 itemId 全串还是 skuId。 */
export type JdProductKeyMode = 'sku' | 'item';

/** 一页订单报文的元数据；rawPayloadId 是该页归档行 id，like 只作构造 Date 的模板（同 PddOrderPage）。 */
export interface JdOrderPage {
  readonly rawPayloadId: string | null;
  readonly like: Date;
  readonly productKeyMode: JdProductKeyMode;
}

/** 一条订单行（内层数字都是 JdRawNumber）→ UnionOrder。 */
export function mapJdOrder(
  input: unknown,
  page: JdOrderPage,
): UnionOrder & UnionOrderNeutralFields {
  void input;
  void page;
  throw new Error('NotImplemented: mapJdOrder');
}
