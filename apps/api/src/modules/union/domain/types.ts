// Unified union DTOs and the UnionAdapter port (规划/02 §6.1). Platform differences (signing,
// field names, paging, time-window limits) stay inside each adapter; everything here is domain
// data, never an upstream response format.
import type { components } from '@couli/contracts-ts';
import type { QuotaPurpose } from '../../platform/index.ts';
import type { PriceAnomalyReason } from './taobao-price.ts';

export type Platform = components['schemas']['PlatformCode'];
export type RegisteredPlatform = Extract<Platform, 'jd' | 'pdd' | 'taobao'>;
export type UnionMode = 'demo' | 'replay' | 'live';
export type UnionEnvironment = 'local' | 'test' | 'staging' | 'prod';

/** Exhaustive at compile time: adding a PlatformCode to the contract fails the build here. */
const PLATFORM_CODES: Readonly<Record<Platform, true>> = {
  taobao: true,
  jd: true,
  pdd: true,
  meituan: true,
  vip: true,
  douyin: true,
  eleme: true,
  kuaishou: true,
  suning: true,
};

export const REGISTERED_PLATFORMS: readonly RegisteredPlatform[] = ['jd', 'pdd', 'taobao'];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && Object.hasOwn(PLATFORM_CODES, value);
}

export function isRegisteredPlatform(value: unknown): value is RegisteredPlatform {
  return typeof value === 'string' && (REGISTERED_PLATFORMS as readonly string[]).includes(value);
}

/**
 * Internal failures, not new HTTP error codes. Adapters report what the platform answered:
 * a business refusal (item_unavailable, link_unrecognized, upstream_rejected) or a dependency
 * failure (upstream_unavailable: network error or 5xx; rate_limited: upstream throttling).
 */
export type UnionErrorCode =
  | 'adapter_unimplemented'
  | 'invalid_endpoint'
  | 'unsafe_mode'
  | 'invalid_dto'
  | 'invalid_identity'
  | 'item_unavailable'
  | 'link_unrecognized'
  | 'upstream_rejected'
  | 'upstream_unavailable'
  | 'rate_limited';

/** The UnionError codes that mean the dependency itself failed (02 §6.2: retry and breaker). */
const DEPENDENCY_FAILURE_CODES: ReadonlySet<UnionErrorCode> = new Set<UnionErrorCode>([
  'upstream_unavailable',
  'rate_limited',
]);

export class UnionError extends Error {
  readonly code: UnionErrorCode;
  readonly platform: Platform | null;

  constructor(code: UnionErrorCode, message: string, platform: Platform | null = null) {
    super(message);
    this.name = 'UnionError';
    this.code = code;
    this.platform = platform;
  }
}

/**
 * Governor classification of an adapter error. A UnionError with a business code means the
 * platform (or this module) answered and said no: `rejected`, never retried, not a breaker
 * failure. Dependency-failure UnionErrors and every other error (network errors, unknown
 * throws) are `failure`; the Governor's own timeout is always a failure.
 */
export function classifyUnionError(error: unknown): 'failure' | 'rejected' {
  if (error instanceof UnionError && !DEPENDENCY_FAILURE_CODES.has(error.code)) return 'rejected';
  return 'failure';
}

export interface UnionEndpoint {
  readonly platform: RegisteredPlatform;
  readonly mode: UnionMode;
  /** No upstream URL is invented for demo. Replay points at the configured WireMock. */
  readonly baseUrl: string | null;
  readonly quotaKey: string;
}

export interface CallCtx {
  readonly appId: string;
  readonly requestId: string;
  readonly purpose: QuotaPurpose;
  readonly scenario?: string;
  /** Supplied by the governed wrapper to the adapter. */
  readonly signal?: AbortSignal;
  readonly baseUrl?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/** Structurally compatible with packages/domain UnionProductPayload (B1-05b). */
export interface ItemRef {
  readonly platform: Platform;
  readonly item_id?: string | null;
  readonly itemId?: string | null;
  readonly skuId?: string | null;
  readonly goods_id?: string | null;
  readonly goods_sign?: string | null;
}

/** BR-PRICE-01 three price fields in integer fen, commission rate in bp, fetch time. */
export interface UnionItem extends ItemRef {
  readonly title: string;
  readonly price_fen: bigint;
  readonly coupon_fen: bigint;
  readonly final_price_fen: bigint;
  readonly commission_rate_bp: bigint;
  readonly quoted_at: string;
  readonly coupon_ids?: string;
  readonly price_status?: 'ok' | 'anomaly';
  readonly price_anomaly_reason?: PriceAnomalyReason;
}

export interface UnionItemDetail extends UnionItem {
  readonly description?: string;
}

/** Domain data, never an invented upstream response format. Percent is e.g. "12.34". */
export interface ItemInput extends ItemRef {
  readonly title: string;
  readonly price_fen: unknown;
  readonly coupon_fen: unknown;
  readonly final_price_fen: unknown;
  readonly commission_percent: string;
}

export interface UnionOrder extends ItemRef {
  readonly order_id: string;
  readonly paid_fen: bigint;
  readonly commission_fen: bigint;
}

export interface OrderInput extends ItemRef {
  readonly order_id: unknown;
  readonly paid_fen: unknown;
  readonly commission_fen: unknown;
}

export interface UnionRefund {
  readonly order_id: string;
  readonly refund_id: string;
  readonly refund_fen: bigint;
}

export interface UnionPunish {
  readonly order_id: string;
  readonly punishment_id: string;
  readonly deduction_fen: bigint;
}

export interface SearchQuery {
  readonly keyword: string;
  readonly cursor?: string;
}
export interface ResolvedLink {
  readonly item: ItemRef;
}
export interface ConvertReq {
  readonly item: ItemRef;
  readonly idempotencyKey: string;
}
export interface IdentityClaims {
  readonly appId: string;
  readonly userId: string;
  readonly platform: Platform;
  readonly promotionSlot: string;
  readonly relationId: string | null;
}

/** Instances built through the UnionIdentity constructor; a forged prototype is not one. */
const constructedIdentities = new WeakSet<object>();

/**
 * The server-side identity for a conversion (BR-ATTR-05, BR-AI-03). Only a trusted linking
 * subclass constructs it; no JSON or plain object is an identity, and union exposes no public
 * factory or constructor.
 */
export abstract class UnionIdentity {
  declare private readonly identityBrand: void;
  readonly claims: IdentityClaims;

  protected constructor(claims: IdentityClaims) {
    this.claims = Object.freeze({
      appId: claims.appId,
      userId: claims.userId,
      platform: claims.platform,
      promotionSlot: claims.promotionSlot,
      relationId: claims.relationId,
    });
    constructedIdentities.add(this);
  }
}

/** True only for an object produced by a UnionIdentity subclass constructor. */
export function isServerIdentity(value: unknown): value is UnionIdentity {
  return (
    typeof value === 'object' &&
    value !== null &&
    value instanceof UnionIdentity &&
    constructedIdentities.has(value)
  );
}

export type ConvertResult =
  | { readonly kind: 'url'; readonly url: string }
  | {
      readonly kind: 'baichuan';
      readonly item: ItemRef;
      readonly promotionSlot: string;
      readonly relationId: string;
    };
export interface BindReq {
  readonly authorizationCode: string;
}
export interface BindResult {
  readonly relationId: string;
}
export interface TimeWindow {
  readonly from: string;
  readonly to: string;
}
export interface OrderQueryOpt {
  readonly cursor?: string;
}
export interface MaterialReq {
  readonly cursor?: string;
}
export interface TljCreateReq {
  readonly item: ItemRef;
  readonly amount_fen: bigint;
  readonly idempotencyKey: string;
}
export interface TljCreateResult {
  readonly id: string;
}

export interface UnionAdapter {
  readonly platform: Platform;
  searchItems(q: SearchQuery, ctx: CallCtx): Promise<Page<UnionItem>>;
  getItem(ref: ItemRef, ctx: CallCtx): Promise<UnionItemDetail>;
  resolveLink(raw: string, ctx: CallCtx): Promise<ResolvedLink>;
  convert(req: ConvertReq, identity: UnionIdentity, ctx: CallCtx): Promise<ConvertResult>;
  bindPublisher?(req: BindReq, ctx: CallCtx): Promise<BindResult>;
  listOrders(win: TimeWindow, opt: OrderQueryOpt, ctx: CallCtx): Promise<Page<UnionOrder>>;
  listRefunds?(win: TimeWindow, ctx: CallCtx): Promise<Page<UnionRefund>>;
  listPunishments?(win: TimeWindow, ctx: CallCtx): Promise<Page<UnionPunish>>;
  materialFeed?(req: MaterialReq, ctx: CallCtx): Promise<Page<UnionItem>>;
  createTaolijin?(req: TljCreateReq, ctx: CallCtx): Promise<TljCreateResult>;
}
