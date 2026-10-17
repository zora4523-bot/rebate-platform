// Public surface of the orders module (规划/02 §4.1); other modules import only from this file.
// Task B1-08h: attribution pipeline main transaction (BR-ATTR-01/02/06/07/08/22/25). The lock,
// user attribution and buy_type helpers are shared with B1-08i, claim and admin changes.
export { createOrderPipeline } from './application/pipeline-port.ts';
export type {
  DropReason,
  OrderPipeline,
  OrderPipelineContext,
  OrderPipelinePort,
} from './application/pipeline-port.ts';
export type {
  ImportedOrder,
  OrderPipelineDeps,
  OrderPipelineResult,
  PidRow,
} from './application/pipeline-types.ts';
export { attributeOrderUser } from './application/attribute-user.ts';
export type {
  AttributeUserInput,
  UserAttribution,
  UserCounter,
} from './application/attribute-user.ts';
export {
  classifyBuyType,
  isKnownPidScene,
  parseAttrCode,
  resolveBinding,
} from './domain/attribution.ts';
export type { BindingDecision, BindingRow, BuyTypeDecision } from './domain/attribution.ts';
export { orderContentHash } from './domain/content-hash.ts';
export { planImportState } from './domain/import-state.ts';
export type { ImportHistory, ImportStateDecision } from './domain/import-state.ts';
export { lockOrderKey, orderLockKeyText } from './infra/order-lock.ts';
