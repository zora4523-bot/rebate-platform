// 淘宝联盟适配器的请求底座（B1-04j，骨架；实现见实现轮）：公共参数（method、app_key、timestamp、
// format=json、v=2.0、sign_method=md5）+ TOP md5 签名、凭据经构造参数注入（每次请求取一次）、
// 经注入的 UnionTransport 发表单 POST 到 endpoint.baseUrl（参数含 sign 全在请求体，URL 不带查询串，
// Content-Type application/x-www-form-urlencoded;charset=utf-8）、按调用方给出的外层键解包。
// 业务参数与公共参数同名 → invalid_dto，不发请求。传输抛错 → upstream_unavailable（不带原文）。
// 调用方的 AbortSignal 与归档上下文原样挂在传输请求上。端口方法一律 adapter_unimplemented，
// 不取凭据、不发请求（字段映射在 ② 段）。不读 process.env、不读文件；app_secret 只在内存参与签名。
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
import type { TaobaoWarning } from './response.ts';
import type { TaobaoParameters } from './sign.ts';

export type { TaobaoParameter, TaobaoParameters } from './sign.ts';
export type { TaobaoWarning } from './response.ts';

/** Application-level key pair; fetched once per request, never stored on the adapter. */
export interface TaobaoCredentials {
  readonly appKey: string;
  readonly appSecret: string;
}

export interface TaobaoAdapterOptions {
  readonly credentials: () => Promise<TaobaoCredentials>;
  readonly transport: UnionTransport;
  readonly clock: Clock;
  readonly endpoint: UnionEndpoint;
  readonly warn?: (event: TaobaoWarning) => void;
}

export interface TaobaoRequestOptions {
  /** The response envelope key registered for this method by the caller (never derived). */
  readonly envelope: string;
  readonly signal?: AbortSignal;
  /** B1-04p: rides on the transport request for the archiving transport only. */
  readonly archive?: ArchiveContext;
}

export class TaobaoUnionAdapter implements UnionAdapter {
  declare readonly platform: 'taobao';

  constructor(options: TaobaoAdapterOptions) {
    void options;
    throw new Error('NotImplemented: TaobaoUnionAdapter');
  }

  /** Internal request foundation; returns the inner object of `options.envelope`. */
  async request(
    method: string,
    parameters: TaobaoParameters,
    options: TaobaoRequestOptions,
  ): Promise<unknown> {
    void method;
    void parameters;
    void options;
    throw new Error('NotImplemented: TaobaoUnionAdapter.request');
  }

  async searchItems(q: SearchQuery, ctx: CallCtx): Promise<Page<UnionItem>> {
    void q;
    void ctx;
    throw new Error('NotImplemented: TaobaoUnionAdapter.searchItems');
  }

  async getItem(ref: ItemRef, ctx: CallCtx): Promise<UnionItemDetail> {
    void ref;
    void ctx;
    throw new Error('NotImplemented: TaobaoUnionAdapter.getItem');
  }

  async resolveLink(raw: string, ctx: CallCtx): Promise<ResolvedLink> {
    void raw;
    void ctx;
    throw new Error('NotImplemented: TaobaoUnionAdapter.resolveLink');
  }

  async convert(req: ConvertReq, identity: UnionIdentity, ctx: CallCtx): Promise<ConvertResult> {
    void req;
    void identity;
    void ctx;
    throw new Error('NotImplemented: TaobaoUnionAdapter.convert');
  }

  async listOrders(win: TimeWindow, opt: OrderQueryOpt, ctx: CallCtx): Promise<Page<UnionOrder>> {
    void win;
    void opt;
    void ctx;
    throw new Error('NotImplemented: TaobaoUnionAdapter.listOrders');
  }
}
