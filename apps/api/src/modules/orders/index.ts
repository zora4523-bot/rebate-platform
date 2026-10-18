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
// Task B1-08l: the shared order list / detail queries (HTTP and later B3-08), already projected.
export {
  createOrderQueries,
  createUnknownOrderFigures,
  OrderQueries,
  OrderQueryError,
} from './application/order-queries.ts';
export type {
  OrderSubject,
  OrderFilter,
  OrderFigures,
  OrderFiguresReader,
  OrderLinkReader,
  OrderQueryDeps,
} from './application/order-queries.ts';
export { OrdersModule } from './orders.module.ts';
export type { OrdersModuleOptions } from './orders.module.ts';
// Task B1-08m: the pending-track cards (BR-ATTR-21) — the pure per-attempt selection and the
// shared queries behind GET /v1/orders/pending-tracks and its dismiss, over linking's port.
export {
  PENDING_TRACK_CLAIM_AFTER_MS,
  PENDING_TRACK_LIFETIME_MS,
  selectPendingTracks,
} from './domain/pending-tracks.ts';
export type { PendingTrackOrder, SelectPendingTracksInput } from './domain/pending-tracks.ts';
export {
  DEFAULT_TRACK_COMPLETE_TOLERANCE_SEC,
  PendingTrackError,
  PendingTracks,
  TRACK_COMPLETE_TOLERANCE_KEY,
  createPendingTracks,
} from './application/pending-tracks.ts';
export type { PendingTracksDeps } from './application/pending-tracks.ts';
export { createOrderUpdateStep } from './application/update-step.ts';
export type {
  OrderUpdateDeps,
  OrderUpdateChange,
  OrderStatusSource,
  UnmappedOrderInfo,
} from './application/update-step.ts';
export type { PlatformStatusEvent } from './domain/status-map.ts';
// B1-08i（D10-47 / D10-48）：order.attr_param_changed 载荷 changed 里的列名（告警事件与领域事件同经 events 总线）。
export type { OrderAttrParamColumn } from './application/alert-events.ts';
export { planOrderUpdate, planOrderSyncColumns } from './domain/update-plan.ts';
export type { OrderUpdatePlan, OrderSyncColumns, UpdateStateInput } from './domain/update-plan.ts';
