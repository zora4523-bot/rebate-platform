// 拼多多联盟适配器的请求底座（4_PDD_附 §3.1–§3.4）：公共参数 + MD5 签名、凭据经构造参数注入、
// 经注入的 UnionTransport 发 POST JSON、按登记的外层键解包、error_response 分类到 UnionError。
// 端口方法的字段映射另开任务，目前一律 adapter_unimplemented（规划/11 §4.5）。
// 不读 process.env、不读文件；client_secret 只在内存里参与签名。
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
import type { UnionTransport, UnionTransportResponse } from '../replay.ts';
import { pddParameterText, signPddParameters, type PddParameters } from './sign.ts';
import { pddEnvelopeKey, unwrapPddResponse, type PddWarning } from './response.ts';

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

/** 公共参数名；业务参数不得占用（4_PDD_附 §3.2）。 */
const PUBLIC_PARAMETERS: ReadonlySet<string> = new Set([
  'type',
  'client_id',
  'timestamp',
  'sign',
  'data_type',
]);

type WireValue = string | number | boolean;

function unimplemented(port: string): UnionError {
  // TODO(规划/11 §4.5): 拼多多端口字段映射 — blocked on CAP-PDD probe 录制（B1-04u / B1-04h / B1-04i）
  return new UnionError('adapter_unimplemented', `pdd adapter: ${port} not implemented`, 'pdd');
}

export class PddUnionAdapter implements UnionAdapter {
  readonly platform = 'pdd' as const;
  readonly #credentials: () => Promise<PddCredentials>;
  readonly #transport: UnionTransport;
  readonly #clock: Clock;
  readonly #endpoint: UnionEndpoint;
  readonly #warn: ((event: PddWarning) => void) | undefined;

  constructor(options: PddAdapterOptions) {
    if (options.endpoint.platform !== 'pdd') {
      throw new UnionError('invalid_endpoint', 'pdd adapter: endpoint is not for pdd', 'pdd');
    }
    this.#credentials = options.credentials;
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#endpoint = options.endpoint;
    this.#warn = options.warn;
  }

  /** Internal request foundation; not exported through the union module's public port. */
  async request(method: string, parameters: PddParameters, signal?: AbortSignal): Promise<unknown> {
    // 先做不需要凭据的同步检查，再取凭据：取凭据之前不 await 别的东西。
    if (pddEnvelopeKey(method) === undefined) {
      throw new UnionError('adapter_unimplemented', `pdd ${method}: not implemented`, 'pdd');
    }
    const url = this.#endpoint.baseUrl;
    if (url === null) {
      throw new UnionError('invalid_endpoint', 'pdd adapter: no gateway URL configured', 'pdd');
    }
    const business = this.#businessParameters(method, parameters);
    const { clientId, clientSecret } = await this.#credentials();

    const unsigned: Record<string, WireValue> = {
      ...business,
      type: method,
      client_id: clientId,
      timestamp: String(Math.floor(this.#clock.now().getTime() / 1000)),
      data_type: 'JSON',
    };
    const body = JSON.stringify({ ...unsigned, sign: signPddParameters(unsigned, clientSecret) });

    let response: UnionTransportResponse;
    try {
      response = await this.#transport({
        platform: 'pdd',
        url,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (error instanceof UnionError) throw error;
      // 未知传输错误不带原文与 cause，避免请求内容进入错误信息。
      throw new UnionError('upstream_unavailable', `pdd ${method}: transport failed`, 'pdd');
    }
    return unwrapPddResponse(method, response, this.#warn);
  }

  /** Business parameters on the wire: structured values become the compact strings they sign as. */
  #businessParameters(method: string, parameters: PddParameters): Record<string, WireValue> {
    const wire: Record<string, WireValue> = {};
    for (const name of Object.keys(parameters)) {
      if (PUBLIC_PARAMETERS.has(name)) {
        throw new UnionError('invalid_dto', `pdd ${method}: reserved parameter ${name}`, 'pdd');
      }
      const value = parameters[name]!;
      if (typeof value === 'number' && !Number.isFinite(value)) {
        throw new UnionError('invalid_dto', `pdd ${method}: non-finite parameter ${name}`, 'pdd');
      }
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        wire[name] = value;
      } else if (value === null || value === undefined) {
        throw new UnionError('invalid_dto', `pdd ${method}: empty parameter ${name}`, 'pdd');
      } else {
        wire[name] = pddParameterText(value);
      }
    }
    return wire;
  }

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
