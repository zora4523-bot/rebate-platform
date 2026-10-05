import type { Clock } from '../../../platform/index.ts';
import type {
  BindReq,
  BindResult,
  CallCtx,
  ConvertReq,
  ConvertResult,
  ItemRef,
  MaterialReq,
  OrderQueryOpt,
  Page,
  RegisteredPlatform,
  ResolvedLink,
  SearchQuery,
  TimeWindow,
  UnionAdapter,
  UnionEndpoint,
  UnionEnvironment,
  UnionIdentity,
  UnionItem,
  UnionItemDetail,
  UnionOrder,
} from '../../domain/types.ts';

/** Internal demo scenarios in CallCtx.scenario; never vendor response codes or payloads.
 * timeout -> Error.code=timeout; rate_limit -> Error.code=quota_exceeded;
 * delisted -> Error.code=demo_delisted for detail/resolve/convert, empty search/feed;
 * coupon_expired -> coupon_fen=0, final_price_fen=price_fen;
 * no_commission -> commission_rate_bp=0. Scenarios affect only the current call.
 */
export type DemoScenario =
  'timeout' | 'rate_limit' | 'delisted' | 'coupon_expired' | 'no_commission';

export interface DemoUnionOptions {
  readonly platform: RegisteredPlatform;
  readonly seed: string;
  readonly clock: Clock;
  /** Supplied by validated application config; prod must reject before serving data. */
  readonly environment: UnionEnvironment;
}

/** Optional argument to the existing registry, wired during implementation.
 * No-argument registration remains compatible with B1-04b.
 */
export interface DemoUnionRegistryOptions {
  readonly endpoints: readonly UnionEndpoint[];
  readonly seed: string;
  readonly clock: Clock;
  readonly environment: UnionEnvironment;
}

/** Synthetic domain DTOs only; not AC-LINK / AC-ORD evidence (规划/11 §4.5).
 * Public export and registry wiring belong to the implementation phase.
 * Demo URLs use https://demo.invalid/<platform>/<encoded raw item identifier>.
 * Titles explicitly contain “演示”; no platform transport or recordings are involved.
 */
export class DemoUnionAdapter implements UnionAdapter {
  declare readonly platform: RegisteredPlatform;

  constructor(options: DemoUnionOptions) {
    void options;
    throw new Error('NotImplemented: DemoUnionAdapter');
  }

  searchItems(q: SearchQuery, ctx: CallCtx): Promise<Page<UnionItem>> {
    void q;
    void ctx;
    throw new Error('NotImplemented: DemoUnionAdapter.searchItems');
  }

  getItem(ref: ItemRef, ctx: CallCtx): Promise<UnionItemDetail> {
    void ref;
    void ctx;
    throw new Error('NotImplemented: DemoUnionAdapter.getItem');
  }

  resolveLink(raw: string, ctx: CallCtx): Promise<ResolvedLink> {
    void raw;
    void ctx;
    throw new Error('NotImplemented: DemoUnionAdapter.resolveLink');
  }

  convert(req: ConvertReq, identity: UnionIdentity, ctx: CallCtx): Promise<ConvertResult> {
    void req;
    void identity;
    void ctx;
    throw new Error('NotImplemented: DemoUnionAdapter.convert');
  }

  bindPublisher(req: BindReq, ctx: CallCtx): Promise<BindResult> {
    void req;
    void ctx;
    throw new Error('NotImplemented: DemoUnionAdapter.bindPublisher');
  }

  materialFeed(req: MaterialReq, ctx: CallCtx): Promise<Page<UnionItem>> {
    void req;
    void ctx;
    throw new Error('NotImplemented: DemoUnionAdapter.materialFeed');
  }

  listOrders(win: TimeWindow, opt: OrderQueryOpt, ctx: CallCtx): Promise<Page<UnionOrder>> {
    void win;
    void opt;
    void ctx;
    throw new Error('NotImplemented: DemoUnionAdapter.listOrders');
  }
}
