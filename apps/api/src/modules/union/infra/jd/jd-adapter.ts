// 京东联盟适配器的请求底座（B1-04za）。规则测试：test/spec/union/jd-core/**。
// 公共参数（method、app_key、timestamp、format=json、v=1.0、sign_method=md5）+ 360buy_param_json
// （业务对象的 JSON 串，业务参数唯一的载体，业务名与公共参数同名也不冲突）+ md5 签名。
// 凭据经构造参数注入（每次请求取一次）、经注入的 UnionTransport 发表单 POST 到 endpoint.baseUrl
// （全部参数在请求体，URL 不带查询串，Content-Type application/x-www-form-urlencoded;charset=utf-8）、
// 按调用方登记的外层键与结果键解包（见 response.ts）。业务对象无法序列化或含非有限数 → invalid_dto，
// 不取凭据、不发请求。传输抛错 → upstream_unavailable（不带原文）。调用方的 AbortSignal 与归档上下文
// 原样挂在传输请求上。searchItems / getItem / resolveLink / convert / listOrders 仍是
// adapter_unimplemented，不取凭据、不发请求。不读 process.env、不读文件；app_secret 只在内存参与签名。
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
import {
  unwrapJdResponse,
  type JdInner,
  type JdInnerCodeMap,
  type JdResponseKeys,
  type JdWarning,
} from './response.ts';
import { jdTimestamp, signJdParameters, type JdParameters } from './sign.ts';

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

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded;charset=utf-8';

function unimplemented(name: string): UnionError {
  return new UnionError('adapter_unimplemented', `jd ${name}: not implemented`, 'jd');
}

/** JSON.stringify turns a non-finite number into null; a request must not silently change. */
function rejectNonFinite(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RangeError('non-finite number');
  }
  return value;
}

/** The business object as JSON text; the error carries no parameter content. */
function businessPayload(method: string, parameters: JdBusinessParameters): string {
  let payload: string | undefined;
  try {
    payload = JSON.stringify(parameters, rejectNonFinite) as string | undefined;
  } catch {
    payload = undefined;
  }
  if (payload === undefined) {
    throw new UnionError('invalid_dto', `jd ${method}: invalid business parameters`, 'jd');
  }
  return payload;
}

export class JdUnionAdapter implements UnionAdapter {
  readonly platform = 'jd' as const;
  readonly #credentials: () => Promise<JdCredentials>;
  readonly #transport: UnionTransport;
  readonly #clock: Clock;
  readonly #endpoint: UnionEndpoint;
  readonly #warn: ((event: JdWarning) => void) | undefined;

  constructor(options: JdAdapterOptions) {
    if (options.endpoint.platform !== 'jd') {
      throw new UnionError('invalid_endpoint', 'jd adapter: endpoint is not for jd', 'jd');
    }
    this.#credentials = options.credentials;
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#endpoint = options.endpoint;
    this.#warn = options.warn;
  }

  /** Internal request foundation; returns the inner object of the registered result key. */
  async request(
    method: string,
    parameters: JdBusinessParameters,
    options: JdRequestOptions,
  ): Promise<JdInner> {
    const { envelope, resultKey, innerCodes } = options;
    // 先做不需要凭据的同步检查，再取凭据：没有登记键的调用不取凭据、不发请求。
    if (typeof envelope !== 'string' || envelope === '') throw unimplemented(method);
    if (typeof resultKey !== 'string' || resultKey === '') throw unimplemented(method);
    const response = await this.#send(method, parameters, options);
    return unwrapJdResponse(method, { envelope, resultKey }, response, this.#warn, innerCodes);
  }

  async #send(
    method: string,
    parameters: JdBusinessParameters,
    { signal, archive }: JdRequestOptions,
  ): Promise<UnionTransportResponse> {
    const url = this.#endpoint.baseUrl;
    if (url === null) {
      throw new UnionError('invalid_endpoint', 'jd adapter: no gateway URL configured', 'jd');
    }
    const payload = businessPayload(method, parameters);
    const { appKey, appSecret } = await this.#credentials();

    const unsigned: JdParameters = {
      method,
      app_key: appKey,
      timestamp: jdTimestamp(this.#clock.now()),
      format: 'json',
      v: '1.0',
      sign_method: 'md5',
      '360buy_param_json': payload,
    };
    // 表单值与签名用同一份文本；请求体里只有 sign，没有 secret。
    const form = new URLSearchParams(unsigned);
    form.append('sign', signJdParameters(unsigned, appSecret));

    try {
      return await this.#transport({
        platform: 'jd',
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
      throw new UnionError('upstream_unavailable', `jd ${method}: transport failed`, 'jd');
    }
  }

  // 端口方法都是占位：等商品、转链、订单各自的任务落地，不取凭据、不发请求。
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
