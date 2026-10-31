// 京东联盟适配器的请求底座（B1-04za）。规则测试：test/spec/union/jd-core/**。
// 骨架：实现阶段补函数体。
import type { Clock } from '../../../platform/index.ts';
import type {
  CallCtx,
  ConvertReq,
  ConvertResult,
  ItemRef,
  OrderQueryOpt,
  Page,
  ResolvedLink,
  SearchQuery,
  TimeWindow,
  UnionAdapter,
  UnionEndpoint,
  UnionIdentity,
  UnionItem,
  UnionItemDetail,
  UnionOrder,
} from '../../domain/types.ts';
import type { ArchiveContext, UnionTransport } from '../replay.ts';
import type { JdInner, JdInnerCodeMap, JdResponseKeys, JdWarning } from './response.ts';

export type { JdInner, JdInnerCodeMap, JdResponseKeys, JdWarning } from './response.ts';

/** Application-level key pair; fetched once per request, never stored on the adapter. */
export interface JdCredentials {
  readonly appKey: string;
  readonly appSecret: string;
}

export interface JdAdapterOptions {
  readonly credentials: () => Promise<JdCredentials>;
  readonly transport: UnionTransport;
  readonly clock: Clock;
  readonly endpoint: UnionEndpoint;
  readonly warn?: (event: JdWarning) => void;
}

/** The business object; 360buy_param_json is its JSON text and its only carrier. */
export type JdBusinessParameters = Readonly<Record<string, unknown>>;

export interface JdRequestOptions extends JdResponseKeys {
  readonly signal?: AbortSignal;
  /** Rides on the transport request for the archiving transport only. */
  readonly archive?: ArchiveContext;
  /** Per-method refinement of the inner code (see response.ts). */
  readonly innerCodes?: JdInnerCodeMap;
}

export class JdUnionAdapter implements UnionAdapter {
  declare readonly platform: 'jd';

  constructor(options: JdAdapterOptions) {
    void options;
    throw new Error('NotImplemented: JdUnionAdapter');
  }

  /** Internal request foundation; returns the inner object of the registered result key. */
  async request(
    method: string,
    parameters: JdBusinessParameters,
    options: JdRequestOptions,
  ): Promise<JdInner> {
    void method;
    void parameters;
    void options;
    throw new Error('NotImplemented: request');
  }

  async searchItems(q: SearchQuery, ctx: CallCtx): Promise<Page<UnionItem>> {
    void q;
    void ctx;
    throw new Error('NotImplemented: searchItems');
  }

  async getItem(ref: ItemRef, ctx: CallCtx): Promise<UnionItemDetail> {
    void ref;
    void ctx;
    throw new Error('NotImplemented: getItem');
  }

  async resolveLink(raw: string, ctx: CallCtx): Promise<ResolvedLink> {
    void raw;
    void ctx;
    throw new Error('NotImplemented: resolveLink');
  }

  async convert(req: ConvertReq, identity: UnionIdentity, ctx: CallCtx): Promise<ConvertResult> {
    void req;
    void identity;
    void ctx;
    throw new Error('NotImplemented: convert');
  }

  async listOrders(win: TimeWindow, opt: OrderQueryOpt, ctx: CallCtx): Promise<Page<UnionOrder>> {
    void win;
    void opt;
    void ctx;
    throw new Error('NotImplemented: listOrders');
  }
}
