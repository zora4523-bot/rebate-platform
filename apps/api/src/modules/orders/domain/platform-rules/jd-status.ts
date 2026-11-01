// B1-04zg（D10-529）：京东 validCode 的两处日志判定，纯函数，不改映射与表外码流程。
// 码到事件的映射在 specs/order-status-map/jd.csv；这里只回答这一行要不要额外写 warn、要不要省掉 warn。
import type { RegisteredPlatform } from '../../../union/index.ts';

/** 京东 14、40 多半是推广位或 siteId 与备案不符：order-sync 处理到时额外写 order_source_mismatch。 */
export function isOrderSourceMismatch(
  platform: RegisteredPlatform,
  rawStatus: string | null,
): boolean {
  return platform === 'jd' && (rawStatus === '14' || rawStatus === '40');
}

/** BR-ATTR-25 京东例外：15 待付款没有付款时间是常态，NO_PAY_TIME 丢弃照记，不写 warn。 */
export function isAwaitingPaymentDrop(
  platform: RegisteredPlatform,
  rawStatus: string | null,
): boolean {
  return platform === 'jd' && rawStatus === '15';
}
