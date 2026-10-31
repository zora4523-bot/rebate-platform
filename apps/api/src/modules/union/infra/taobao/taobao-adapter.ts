// 淘宝联盟适配器的请求底座（B1-04j）：公共参数（method、app_key、timestamp、
// format=json、v=2.0、sign_method=md5）+ TOP md5 签名、凭据经构造参数注入（每次请求取一次）、
// 经注入的 UnionTransport 发表单 POST 到 endpoint.baseUrl（参数含 sign 全在请求体，URL 不带查询串，
// Content-Type application/x-www-form-urlencoded;charset=utf-8）、按调用方给出的外层键解包。
// 业务参数与公共参数同名 → invalid_dto，不发请求。传输抛错 → upstream_unavailable（不带原文）。
// 调用方的 AbortSignal 与归档上下文原样挂在传输请求上。searchItems / resolveLink /
// listOrders（与未打开大淘客转链时的 convert）仍是 adapter_unimplemented，不取凭据、不发请求。不读 process.env、不读文件；
// app_secret 只在内存参与签名。
//
// B1-04l（② 段）：
// - getItem：taobao.tbk.item.info.upgrade.get，参数 item_id（ItemRef.item_id 原样，一次一个）、
//   biz_scene_id=1；外层键 tbk_item_info_upgrade_get_response（TODO 待详情录制核对）；results 下按
//   「单键包装取其数组」通用解包（不写死包装名），取第一条；空 → item_unavailable。映射见 goods.ts；
//   价格配置 priceSettings.read(ctx.appId) 每次 getItem 读一次（不缓存）。错误：15 + 50001 →
//   item_unavailable，15 + 1911 → upstream_rejected，其余按 B1-04j。归档 kind = query。
// - taobaoShareCode：taobao.tbk.tpwd.create，只传 url；15 + 26 / 23 → link_unrecognized。
//   归档 kind = convert。见 links.ts。
// - shortenTaobaoUrl：taobao.tbk.spread.get，requests = [{url}] 的 JSON 串。归档 kind = convert。
//   见 links.ts。
// 入参不合格一律 invalid_dto，不取凭据、不发请求。
//
// B1-04d（D10-503 ①）：convertSource='dataoke' 且有 orderSource 时，convert 经大淘客
// GET /api/tb-service/get-privilege-link（version v1.3.1）转链，参数与映射见 privilege-link.ts；
// 归档 kind = convert。否则 convert 保持 adapter_unimplemented（不取凭据、不发请求）。
import type { Clock } from '../../../platform/index.ts';
import type { TaobaoPriceOptions, TaobaoPriceSettingsReader } from '../../domain/taobao-price.ts';
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
  type TaobaoShareCode,
  type TimeWindow,
  type UnionAdapter,
  type UnionEndpoint,
  type UnionIdentity,
  type UnionItem,
  type UnionItemDetail,
  type UnionOrder,
} from '../../domain/types.ts';
import type { DataokeClient } from '../dataoke/dataoke-client.ts';
import type { ArchiveContext, UnionTransport, UnionTransportResponse } from '../replay.ts';
import {
  detailItemId,
  detailRows,
  mapTaobaoDetail,
  TAOBAO_ITEM_DETAIL,
  TAOBAO_ITEM_DETAIL_ENVELOPE,
  TAOBAO_ITEM_DETAIL_SCENE,
} from './goods.ts';
import {
  checkShareLink,
  checkSpreadLink,
  parseShareCode,
  parseShortLink,
  TAOBAO_SPREAD_GET,
  TAOBAO_SPREAD_GET_ENVELOPE,
  TAOBAO_TPWD_CREATE,
  TAOBAO_TPWD_CREATE_ENVELOPE,
  TAOBAO_TPWD_SUB_CODES,
} from './links.ts';
import {
  DATAOKE_PRIVILEGE_LINK_CODES,
  DATAOKE_PRIVILEGE_LINK_PATH,
  DATAOKE_PRIVILEGE_LINK_VERSION,
  mapPrivilegeLink,
  privilegeLinkParameters,
} from './privilege-link.ts';
import { unwrapTaobaoResponse, type TaobaoSubCodeMap, type TaobaoWarning } from './response.ts';
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
  /**
   * B1-04l (D10-479): BR-PRICE-02 settings (price.taobao.*), read with ctx.appId once per getItem
   * and passed to mapTaobaoPrice. Without it the BR-PRICE-02 defaults apply.
   */
  readonly priceSettings?: TaobaoPriceSettingsReader;
  /**
   * B1-04e (D10-486 ①): the 大淘客 client the order / refund / punishment ports will read from
   * (mapping is B1-04f / B1-04z). Assembled by the registry from `taobaoLive.orderSource` only in
   * staging with taobao live and both DATAOKE_* variables set. Without it listOrders (and the
   * absent listRefunds / listPunishments) behave as before.
   */
  readonly orderSource?: DataokeClient;
  /**
   * B1-04d (D10-503 ①): where convert gets its link until the official 万能转链 is approved.
   * 'dataoke' with an `orderSource` converts through that client (privilege-link.ts); absent,
   * 'baichuan', or no `orderSource` leaves convert exactly as before (adapter_unimplemented,
   * nothing fetched or sent).
   */
  readonly convertSource?: TaobaoConvertSource;
}

/** B1-04d: the convert data-source switch; the default is 'baichuan' (behaviour unchanged). */
export type TaobaoConvertSource = 'baichuan' | 'dataoke';

export interface TaobaoRequestOptions {
  /** The response envelope key registered for this method by the caller (never derived). */
  readonly envelope: string;
  readonly signal?: AbortSignal;
  /** B1-04p: rides on the transport request for the archiving transport only. */
  readonly archive?: ArchiveContext;
  /** B1-04l: per-method refinement of code 15 by sub_code (see response.ts). */
  readonly businessSubCodes?: TaobaoSubCodeMap;
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

/** item.info.upgrade.get 的 15 细分：50001 无结果（不存在 / 不可推广）、1911 scene 不支持。 */
const DETAIL_SUB_CODES: TaobaoSubCodeMap = Object.freeze({
  '50001': 'item_unavailable',
  '1911': 'upstream_rejected',
});

function archiveOf(ctx: CallCtx, kind: 'query' | 'convert'): ArchiveContext {
  return { appId: ctx.appId, kind };
}

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
  readonly #priceSettings: TaobaoPriceSettingsReader | undefined;
  readonly #orderSource: DataokeClient | undefined;
  readonly #convertSource: TaobaoConvertSource;

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
    this.#priceSettings = options.priceSettings;
    this.#orderSource = options.orderSource;
    // 只有明确的 'dataoke' 打开大淘客转链；缺省与其他值一律是 baichuan（行为不变）。
    this.#convertSource = options.convertSource === 'dataoke' ? 'dataoke' : 'baichuan';
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
    return unwrapTaobaoResponse(method, envelope, response, this.#warn, options.businessSubCodes);
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

  // 端口方法：searchItems / resolveLink / listOrders 仍 adapter_unimplemented，
  // 不取凭据、不发请求（convert 见 B1-04d）。
  async searchItems(q: SearchQuery, ctx: CallCtx): Promise<Page<UnionItem>> {
    void q;
    void ctx;
    throw unimplemented('searchItems');
  }

  /** B1-04l: taobao.tbk.item.info.upgrade.get (see the header). */
  async getItem(ref: ItemRef, ctx: CallCtx): Promise<UnionItemDetail> {
    const itemId = detailItemId(ref);
    const inner = await this.request(
      TAOBAO_ITEM_DETAIL,
      { item_id: itemId, biz_scene_id: TAOBAO_ITEM_DETAIL_SCENE },
      {
        envelope: TAOBAO_ITEM_DETAIL_ENVELOPE,
        archive: archiveOf(ctx, 'query'),
        businessSubCodes: DETAIL_SUB_CODES,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      },
    );
    const rows = detailRows(inner);
    const priceOptions = await this.#priceOptions(ctx);
    return mapTaobaoDetail(rows[0], itemId, this.#clock.now(), priceOptions);
  }

  /** B1-04l: taobao.tbk.tpwd.create (see the header). */
  async taobaoShareCode(url: string, ctx: CallCtx): Promise<TaobaoShareCode> {
    const link = checkShareLink(url);
    const inner = await this.request(
      TAOBAO_TPWD_CREATE,
      { url: link },
      {
        envelope: TAOBAO_TPWD_CREATE_ENVELOPE,
        archive: archiveOf(ctx, 'convert'),
        businessSubCodes: TAOBAO_TPWD_SUB_CODES,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      },
    );
    return parseShareCode(inner);
  }

  /** B1-04l: taobao.tbk.spread.get (see the header). */
  async shortenTaobaoUrl(url: string, ctx: CallCtx): Promise<string> {
    const link = checkSpreadLink(url);
    const inner = await this.request(
      TAOBAO_SPREAD_GET,
      { requests: JSON.stringify([{ url: link }]) },
      {
        envelope: TAOBAO_SPREAD_GET_ENVELOPE,
        archive: archiveOf(ctx, 'convert'),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      },
    );
    return parseShortLink(inner);
  }

  /** The calling app's BR-PRICE-02 settings, read on every getItem; undefined → 08 defaults. */
  async #priceOptions(ctx: CallCtx): Promise<TaobaoPriceOptions | undefined> {
    return this.#priceSettings === undefined ? undefined : this.#priceSettings.read(ctx.appId);
  }

  async resolveLink(raw: string, ctx: CallCtx): Promise<ResolvedLink> {
    void raw;
    void ctx;
    throw unimplemented('resolveLink');
  }

  /** B1-04d: 大淘客 get-privilege-link when switched on (see the header); otherwise unimplemented. */
  async convert(req: ConvertReq, identity: UnionIdentity, ctx: CallCtx): Promise<ConvertResult> {
    const source = this.#orderSource;
    if (this.#convertSource !== 'dataoke' || source === undefined) throw unimplemented('convert');
    const parameters = privilegeLinkParameters(req, identity);
    const data = await source.request('GET', DATAOKE_PRIVILEGE_LINK_PATH, parameters, {
      version: DATAOKE_PRIVILEGE_LINK_VERSION,
      archive: archiveOf(ctx, 'convert'),
      outerCodes: DATAOKE_PRIVILEGE_LINK_CODES,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    // BR-PRICE-11：quoted_at 取收到响应后的注入时钟。
    return mapPrivilegeLink(data, this.#clock.now(), this.#warn);
  }

  async listOrders(win: TimeWindow, opt: OrderQueryOpt, ctx: CallCtx): Promise<Page<UnionOrder>> {
    void win;
    void opt;
    void ctx;
    throw unimplemented('listOrders');
  }
}
