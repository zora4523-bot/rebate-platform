// 淘宝联盟适配器的请求底座（B1-04j）：公共参数（method、app_key、timestamp、
// format=json、v=2.0、sign_method=md5）+ TOP md5 签名、凭据经构造参数注入（每次请求取一次）、
// 经注入的 UnionTransport 发表单 POST 到 endpoint.baseUrl（参数含 sign 全在请求体，URL 不带查询串，
// Content-Type application/x-www-form-urlencoded;charset=utf-8）、按调用方给出的外层键解包。
// 业务参数与公共参数同名 → invalid_dto，不发请求。传输抛错 → upstream_unavailable（不带原文）。
// 调用方的 AbortSignal 与归档上下文原样挂在传输请求上。端口方法一律 adapter_unimplemented，
// 不取凭据、不发请求（字段映射在 ② 段）。不读 process.env、不读文件；app_secret 只在内存参与签名。
import type { Clock } from '../../../platform/index.ts';
import {
  UnionError,
  type CallCtx,
  type ConvertReq,
  type ConvertResult,
  type ItemRef,
  type OrderQueryOpt,
  type Page,
  type ResolvedLink,
  type SearchQuery,
  type TimeWindow,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionIdentity,
  type UnionItem,
  type UnionItemDetail,
  type UnionOrder,
} from '../../domain/types.ts';
import type { ArchiveContext, UnionTransport, UnionTransportResponse } from '../replay.ts';
import { unwrapTaobaoResponse, type TaobaoWarning } from './response.ts';
import {
  signTaobaoParameters,
  taobaoSignedEntries,
  taobaoTimestamp,
  type TaobaoParameters,
} from './sign.ts';

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

/** 公共参数名；业务参数不得占用（同名 → invalid_dto，不发请求）。 */
const PUBLIC_PARAMETERS: ReadonlySet<string> = new Set([
  'method',
  'app_key',
  'timestamp',
  'format',
  'v',
  'sign_method',
  'sign',
]);

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=utf-8';

function unimplemented(name: string): UnionError {
  return new UnionError('adapter_unimplemented', `taobao ${name}: not implemented`, 'taobao');
}

export class TaobaoUnionAdapter implements UnionAdapter {
  readonly platform = 'taobao' as const;
  readonly #credentials: () => Promise<TaobaoCredentials>;
  readonly #transport: UnionTransport;
  readonly #clock: Clock;
  readonly #endpoint: UnionEndpoint;
  readonly #warn: ((event: TaobaoWarning) => void) | undefined;

  constructor(options: TaobaoAdapterOptions) {
    if (options.endpoint.platform !== 'taobao') {
      throw new UnionError(
        'invalid_endpoint',
        'taobao adapter: endpoint is not for taobao',
        'taobao',
      );
    }
    this.#credentials = options.credentials;
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#endpoint = options.endpoint;
    this.#warn = options.warn;
  }

  /** Internal request foundation; returns the inner object of `options.envelope`. */
  async request(
    method: string,
    parameters: TaobaoParameters,
    options: TaobaoRequestOptions,
  ): Promise<unknown> {
    const { envelope } = options;
    // 先做不需要凭据的同步检查，再取凭据：没有外层键的调用不取凭据、不发请求。
    if (typeof envelope !== 'string' || envelope === '') throw unimplemented(method);
    const response = await this.#send(method, parameters, options);
    return unwrapTaobaoResponse(method, envelope, response, this.#warn);
  }

  async #send(
    method: string,
    parameters: TaobaoParameters,
    { signal, archive }: TaobaoRequestOptions,
  ): Promise<UnionTransportResponse> {
    const url = this.#endpoint.baseUrl;
    if (url === null) {
      throw new UnionError(
        'invalid_endpoint',
        'taobao adapter: no gateway URL configured',
        'taobao',
      );
    }
    this.#checkBusinessParameters(method, parameters);
    const { appKey, appSecret } = await this.#credentials();

    const unsigned: TaobaoParameters = {
      ...parameters,
      method,
      app_key: appKey,
      timestamp: taobaoTimestamp(this.#clock.now()),
      format: 'json',
      v: '2.0',
      sign_method: 'md5',
    };
    // 表单值与签名用同一份文本（空值不进表单也不进签名）；请求体里只有 sign，没有 secret。
    const form = new URLSearchParams(taobaoSignedEntries(unsigned));
    form.append('sign', signTaobaoParameters(unsigned, appSecret));

    try {
      return await this.#transport({
        platform: 'taobao',
        url,
        method: 'POST',
        headers: { 'content-type': FORM_CONTENT_TYPE },
        body: form.toString(),
        ...(signal === undefined ? {} : { signal }),
        ...(archive === undefined ? {} : { archive }),
      });
    } catch (error) {
      if (error instanceof UnionError) throw error;
      // 未知传输错误不带原文与 cause，避免请求内容进入错误信息。
      throw new UnionError('upstream_unavailable', `taobao ${method}: transport failed`, 'taobao');
    }
  }

  /** Business parameters may not take a public parameter name nor a non-finite number. */
  #checkBusinessParameters(method: string, parameters: TaobaoParameters): void {
    for (const name of Object.keys(parameters)) {
      if (PUBLIC_PARAMETERS.has(name)) {
        throw new UnionError(
          'invalid_dto',
          `taobao ${method}: reserved parameter ${name}`,
          'taobao',
        );
      }
      const value = parameters[name];
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new UnionError(
          'invalid_dto',
          `taobao ${method}: non-finite parameter ${name}`,
          'taobao',
        );
      }
    }
  }

  // 端口方法：字段映射在 ② 段，先一律 adapter_unimplemented，不取凭据、不发请求。
  async searchItems(q: SearchQuery, ctx: CallCtx): Promise<Page<UnionItem>> {
    void q;
    void ctx;
    throw unimplemented('searchItems');
  }

  async getItem(ref: ItemRef, ctx: CallCtx): Promise<UnionItemDetail> {
    void ref;
    void ctx;
    throw unimplemented('getItem');
  }

  async resolveLink(raw: string, ctx: CallCtx): Promise<ResolvedLink> {
    void raw;
    void ctx;
    throw unimplemented('resolveLink');
  }

  async convert(req: ConvertReq, identity: UnionIdentity, ctx: CallCtx): Promise<ConvertResult> {
    void req;
    void identity;
    void ctx;
    throw unimplemented('convert');
  }

  async listOrders(win: TimeWindow, opt: OrderQueryOpt, ctx: CallCtx): Promise<Page<UnionOrder>> {
    void win;
    void opt;
    void ctx;
    throw unimplemented('listOrders');
  }
}
