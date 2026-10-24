// Public surface of the payment module (apps/api/AGENTS.md: the only import point for other
// modules). The Nest module for the api and worker entries (B2-15b, B2-15c), the ports and their
// types; no table of this module is reachable from here.
export { PaymentModule, PAY_JOBS, payChannelSetFor } from './payment.module.ts';
export type { PaymentModuleOptions } from './payment.module.ts';
export { createPayJobHandler } from './jobs/pay-jobs.ts';
export type { PayJobDeps, PayLedgerPort } from './jobs/pay-jobs.ts';
export { PAY_ORDER_PAID_EVENT } from './application/pay-settlement.ts';
export type { NotifyAnswer } from './application/pay-notifications.ts';
export { PayChannelSet, PayChannelUnavailable } from './application/pay-channel.ts';
export { createBizRegistry, TEST_ITEM_BIZ_TYPE } from './application/biz-registry.ts';
export type {
  AlipayLaunch,
  PayChannel,
  PayChannelIdentity,
  PayCloseResult,
  PayCreateOrderInput,
  PayCreateOrderResult,
  PayLaunch,
  PayNotificationResult,
  PayQueryResult,
  PayRawNotification,
  PayTradeState,
  WechatLaunch,
} from './application/pay-channel.ts';
export type {
  BizFulfillmentHandler,
  BizPrice,
  BizPriceInput,
  BizReconcileInput,
  BizTypeEntry,
  BizTypeRegistry,
} from './application/biz-registry.ts';
export type {
  PayChannelCode,
  PayFulfillmentState,
  PayJobName,
  PayOrderStatus,
  PayPlatform,
  PayQueueName,
  PayUnavailableReason,
} from './domain/types.ts';
export {
  BIZ_RECONCILE_JOB,
  ORDER_CLOSE_JOB,
  ORDER_QUERY_JOB,
  PAY_QUEUE,
  bizReconcileKey,
  orderCloseKey,
  orderQueryReturnedKey,
  orderQueryScheduledKey,
} from './jobs/names.ts';
export type {
  BizReconcilePayload,
  OrderClosePayload,
  OrderQueryPayload,
  OrderQueryReturnedPayload,
  OrderQueryScheduledPayload,
} from './jobs/names.ts';
