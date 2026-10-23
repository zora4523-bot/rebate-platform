// B2-15b: value types of the payment domain (08 BR-PAY-01 / 02; contracts/enums/pay.yaml).
// Types only: the values live in the contract enums and in the rule tests.

/** Collection channel (enum pay_channel, BR-PAY-01); unrelated to payout_channel. */
export type PayChannelCode = 'wechat_pay' | 'alipay';

/**
 * Native app platforms a business type can be sold on (BR-PAY-01: the three apps; client_platform
 * without h5 / admin, which never place an order, BR-PAY-01 ②).
 */
export type PayPlatform = 'ios' | 'android' | 'harmony';

/**
 * data.reason of 30901 (enum pay_unavailable_reason, BR-PAY-01 ④), in the order the checks run:
 * pay_disabled → channel_disabled → platform_not_allowed → biz_not_sellable (task B2-15b §9.3).
 */
export type PayUnavailableReason =
  'pay_disabled' | 'channel_disabled' | 'platform_not_allowed' | 'biz_not_sellable';

/** pay_orders.status (enum pay_order_status, BR-PAY-02; specs/state-machines/pay-order.yaml). */
export type PayOrderStatus = 'PENDING' | 'PAID' | 'CLOSED';

/** The queue of the payment jobs (platform/queue/catalog.ts, worker entry). */
export type PayQueueName = 'pay';

/**
 * Job names inside queue `pay` (task B2-15b §9.8 / §9.9; handlers in B2-15c / B2-15d):
 * order.query (singletonKey `order.query:<pay_order_id>:returned` for the client-return query),
 * order.close (singletonKey `order.close:<pay_order_id>`).
 */
export type PayJobName = 'order.query' | 'order.close';
