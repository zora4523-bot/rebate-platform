// Public surface of the union module (规划/02 §4.1, §6). Other modules import only from this file.
export {
  REGISTERED_PLATFORMS,
  UnionError,
  UnionIdentity,
  isPlatform,
  isRegisteredPlatform,
} from './domain/types.ts';
export type {
  BindReq,
  BindResult,
  CallCtx,
  ConvertReq,
  ConvertResult,
  IdentityClaims,
  ItemInput,
  ItemRef,
  MaterialReq,
  OrderInput,
  OrderQueryOpt,
  Page,
  PddAuthority,
  PddAuthorityUrl,
  PddPromotionUrlExtras,
  PddOrderFields,
  Platform,
  RegisteredPlatform,
  ResolvedLink,
  SearchQuery,
  TimeWindow,
  TljCreateReq,
  TljCreateResult,
  UnionAdapter,
  UnionEndpoint,
  UnionEnvironment,
  UnionErrorCode,
  UnionItem,
  UnionItemDetail,
  UnionMode,
  UnionOrder,
  UnionOrderAttrParams,
  UnionOrderNeutralFields,
  UnionPunish,
  UnionRefund,
} from './domain/types.ts';
export { makeUnionItem, makeUnionOrder } from './domain/dto.ts';
export { quoteN } from './domain/quote-n.ts';
export type { PddQuoteFactors, QuoteNInput } from './domain/quote-n.ts';
export { mapTaobaoPrice, isPriceAnomaly } from './domain/taobao-price.ts';
export type {
  PriceAnomalyReason,
  TaobaoPriceInput,
  TaobaoPriceOptions,
  TaobaoPriceResult,
  TaobaoPriceWarning,
  TaobaoPromotion,
} from './domain/taobao-price.ts';
export { createUnionRegistry } from './infra/registry.ts';
export { DemoUnionAdapter, DemoUnionError } from './infra/demo/demo-adapter.ts';
export type {
  DemoScenario,
  DemoUnionErrorCode,
  DemoUnionOptions,
  DemoUnionRegistryOptions,
} from './infra/demo/demo-adapter.ts';
export type { UnionRegistration, UnionRegistry } from './infra/registry.ts';
export { loadUnionEndpoints, parseUnionEndpoints } from './infra/endpoints.ts';
export { createGovernedAdapter } from './application/governed-adapter.ts';
// B1-08n: the order-sync wiring's union side (SyncAccessPort, pipeline readers, worker governance).
export {
  createUnionSyncAccess,
  createUnionOrderReaders,
  createGovernedSyncAdapter,
} from './application/order-sync-ports.ts';
export type {
  UnionOrderReaders,
  UnionSyncAccess,
  UnionSyncAccessOptions,
  UnionSyncAccount,
} from './application/order-sync-ports.ts';
export { UnionPidError, createUnionPidService } from './pids/service.ts';
export type {
  AccountRow as UnionAccountRow,
  ActivePidInput,
  ConfirmHjyInput,
  PidPlatform,
  PidRow as UnionPidRow,
  PidServiceDeps,
  PidStatus,
  PidWarnLogger,
  RegisterAccountInput,
  RegisterPidInput,
  SetPidStatusInput,
  SuperVerification,
  UnionAuditInput,
  UnionAuditWriter,
  UnionPidErrorCode,
  UnionPidService,
  VerifiedSuper,
  WhitelistInput,
  WriteContext as UnionWriteContext,
} from './pids/service.ts';
export type { GovernedAdapterOptions } from './application/governed-adapter.ts';
export {
  createUnionFileReplay,
  createUnionReplayClient,
  parseUnionRecordingProvenance,
  UnionReplayError,
} from './infra/replay.ts';
export type {
  UnionFileReplay,
  UnionFileReplayOptions,
  UnionLoadedRecording,
  UnionRecordingProvenance,
  UnionReplayClient,
  UnionReplayClientOptions,
  UnionReplayErrorCode,
  UnionReplayReport,
  UnionReplayRequest,
  UnionTransport,
  UnionTransportRequest,
  UnionTransportResponse,
} from './infra/replay.ts';
export {
  UNION_ENDPOINTS,
  UNION_ENDPOINTS_DIR,
  UNION_REGISTRY,
  UnionModule,
} from './union.module.ts';
