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
import type { UnionTransport } from '../replay.ts';
import type { PddParameters } from './sign.ts';
import type { PddWarning } from './response.ts';

export interface PddCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface PddAdapterOptions {
  readonly credentials: () => Promise<PddCredentials>;
  readonly transport: UnionTransport;
  readonly clock: Clock;
  readonly endpoint: UnionEndpoint;
  readonly warn?: (event: PddWarning) => void;
}

export class PddUnionAdapter implements UnionAdapter {
  readonly platform!: 'pdd';

  constructor(options: PddAdapterOptions) {
    void options;
    throw new Error('NotImplemented: PddUnionAdapter');
  }

  /** Internal request foundation; not exported through the union module's public port. */
  async request(method: string, parameters: PddParameters, signal?: AbortSignal): Promise<unknown> {
    void method;
    void parameters;
    void signal;
    throw new Error('NotImplemented: PddUnionAdapter.request');
  }

  async searchItems(q: SearchQuery, ctx: CallCtx): Promise<Page<UnionItem>> {
    void q;
    void ctx;
    throw new Error('NotImplemented: PddUnionAdapter.searchItems');
  }

  async getItem(ref: ItemRef, ctx: CallCtx): Promise<UnionItemDetail> {
    void ref;
    void ctx;
    throw new Error('NotImplemented: PddUnionAdapter.getItem');
  }

  async resolveLink(raw: string, ctx: CallCtx): Promise<ResolvedLink> {
    void raw;
    void ctx;
    throw new Error('NotImplemented: PddUnionAdapter.resolveLink');
  }

  async convert(req: ConvertReq, identity: UnionIdentity, ctx: CallCtx): Promise<ConvertResult> {
    void req;
    void identity;
    void ctx;
    throw new Error('NotImplemented: PddUnionAdapter.convert');
  }

  async listOrders(win: TimeWindow, opt: OrderQueryOpt, ctx: CallCtx): Promise<Page<UnionOrder>> {
    void win;
    void opt;
    void ctx;
    throw new Error('NotImplemented: PddUnionAdapter.listOrders');
  }
}
