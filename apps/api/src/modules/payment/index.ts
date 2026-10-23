// Public surface of the payment module (apps/api/AGENTS.md: the only import point for other
// modules). Ports and types only; the module class and its controllers join with the
// implementation of B2-15b.
export { PayChannelSet } from './application/pay-channel.ts';
export { createBizRegistry } from './application/biz-registry.ts';
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
