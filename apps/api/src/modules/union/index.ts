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
  UnionPunish,
  UnionRefund,
} from './domain/types.ts';
export { makeUnionItem, makeUnionOrder } from './domain/dto.ts';
export { createUnionRegistry } from './infra/registry.ts';
export type { UnionRegistration, UnionRegistry } from './infra/registry.ts';
export { loadUnionEndpoints, parseUnionEndpoints } from './infra/endpoints.ts';
export { createGovernedAdapter } from './application/governed-adapter.ts';
export type { GovernedAdapterOptions } from './application/governed-adapter.ts';
export {
  UNION_ENDPOINTS,
  UNION_ENDPOINTS_DIR,
  UNION_REGISTRY,
  UnionModule,
} from './union.module.ts';
