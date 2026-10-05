import type { components } from '@couli/contracts-ts';
import type { Clock, QuotaLimiter, QuotaPurpose, Scheduler } from '../platform/index.ts';

export type Platform = components['schemas']['PlatformCode'];
export type RegisteredPlatform = Extract<Platform, 'jd' | 'pdd' | 'taobao'>;
export type UnionMode = 'demo' | 'replay' | 'live';
export type UnionEnvironment = 'local' | 'test' | 'staging' | 'prod';

/** Internal failures, not new HTTP error codes. */
export type UnionErrorCode =
  'adapter_unimplemented' | 'invalid_endpoint' | 'unsafe_mode' | 'invalid_dto' | 'invalid_identity';

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

/** Structurally compatible with B1-05b's domain UnionProductPayload; no app type in domain. */
export interface ItemRef {
  readonly platform: Platform;
  readonly item_id?: string | null;
  readonly itemId?: string | null;
  readonly skuId?: string | null;
  readonly goods_id?: string | null;
  readonly goods_sign?: string | null;
}

export interface UnionItem extends ItemRef {
  readonly title: string;
  readonly price_fen: bigint;
  readonly coupon_fen: bigint;
  readonly final_price_fen: bigint;
  readonly commission_rate_bp: bigint;
  readonly quoted_at: string;
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

/** Only a trusted linking subclass constructs this nominal server-side identity.
 * No JSON/plain object is an identity; union exposes no public factory or constructor.
 */
export abstract class UnionIdentity {
  private readonly identityBrand!: void;
  readonly claims!: IdentityClaims;

  protected constructor(claims: IdentityClaims) {
    void claims;
    throw new Error('NotImplemented: UnionIdentity');
  }
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

export interface UnionRegistration {
  readonly platform: RegisteredPlatform;
  readonly implemented: false;
}
export interface UnionRegistry {
  registrations(): readonly UnionRegistration[];
  get(platform: RegisteredPlatform): UnionAdapter;
}
export interface GovernedAdapterOptions {
  readonly endpoint: UnionEndpoint;
  readonly scheduler: Scheduler;
  /** Must match endpoint.quotaKey. Shared instances allow account-wide quota sharing. */
  readonly quota: QuotaLimiter;
}

/** Exactly jd/pdd/taobao registered, all calls reject adapter_unimplemented. */
export function createUnionRegistry(): UnionRegistry {
  throw new Error('NotImplemented: createUnionRegistry');
}

/** Read <directory>/<platform>.json for each registered platform, then validate as a set. */
export function loadUnionEndpoints(
  directory: string,
  environment: UnionEnvironment,
): Promise<readonly UnionEndpoint[]> {
  void directory;
  void environment;
  throw new Error('NotImplemented: loadUnionEndpoints');
}

/** Reject incomplete/duplicate sets and prod demo/replay. No network or environment reads. */
export function parseUnionEndpoints(
  input: unknown,
  environment: UnionEnvironment,
): readonly UnionEndpoint[] {
  void input;
  void environment;
  throw new Error('NotImplemented: parseUnionEndpoints');
}

/** Wrap all supported operations through platform/http Governor; preserve absent optionals.
 * online => 3s; all other purposes => 10s. convert/bindPublisher/createTaolijin are writes.
 * Copy context; overwrite signal/baseUrl/headers using configuration (X-Scenario in replay).
 * Validate identity app/platform before convert, with invalid_identity on plain JSON/mismatch.
 */
export function createGovernedAdapter(
  adapter: UnionAdapter,
  options: GovernedAdapterOptions,
): UnionAdapter {
  void adapter;
  void options;
  throw new Error('NotImplemented: createGovernedAdapter');
}

/** Use @couli/money parsing; nonnegative prices and exact injected clock timestamp. */
export function makeUnionItem(input: ItemInput, clock: Clock): UnionItem {
  void input;
  void clock;
  throw new Error('NotImplemented: makeUnionItem');
}

/** Never coerce an order number to/from number: string identifiers preserve leading zeroes. */
export function makeUnionOrder(input: OrderInput): UnionOrder {
  void input;
  throw new Error('NotImplemented: makeUnionOrder');
}
