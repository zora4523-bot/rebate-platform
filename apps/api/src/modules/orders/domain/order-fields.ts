// B1-08h / B1-08i：同步列的取值函数（首次入库与后续更新共用；纯函数，不读写库）。
import type { UnionOrder } from '../../union/index.ts';

const DECIMAL = /^[0-9]+$/;

/** raw_payload_id：union 给十进制字符串（未归档为 null），orders 存 bigint。 */
export function rawPayloadId(order: UnionOrder): bigint | null {
  const value = order.raw_payload_id ?? null;
  if (value === null) return null;
  if (!DECIMAL.test(value))
    throw new Error('INVALID_RAW_PAYLOAD_ID: raw_payload_id 不是十进制整数');
  return BigInt(value);
}

/** B1-08h 待编排裁定 8：raw_item_id（NOT NULL）回退顺序；全空得 ''（调用方告警）。 */
export function rawItemId(order: UnionOrder): string {
  return order.goods_id ?? order.goods_sign ?? order.item_id ?? order.itemId ?? order.skuId ?? '';
}
