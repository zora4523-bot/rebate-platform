// Public surface of the payment module (apps/api/AGENTS.md: the only import point for other
// modules). The Nest module for the api entry (B2-15b), the ports and their types; no table of
// this module is reachable from here.
export { PaymentModule, payChannelSetFor } from './payment.module.ts';
export type { PaymentModuleOptions } from './payment.module.ts';
export { PayChannelSet, PayChannelUnavailable } from './application/pay-channel.ts';
export { createBizRegistry, TEST_ITEM_BIZ_TYPE } from './application/biz-registry.ts';
export type {
  AlipayLaunch,
  PayChannel,
  PayCloseResult,
  PayCreateOrderInput,
  PayCreateOrderResult,
  PayLaunch,
  PayQueryResult,
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
  PayJobName,
  PayOrderStatus,
  PayPlatform,
  PayQueueName,
  PayUnavailableReason,
} from './domain/types.ts';
export {
  ORDER_CLOSE_JOB,
  ORDER_QUERY_JOB,
  PAY_QUEUE,
  orderCloseKey,
  orderQueryReturnedKey,
} from './jobs/names.ts';
export type { OrderClosePayload, OrderQueryPayload } from './jobs/names.ts';
