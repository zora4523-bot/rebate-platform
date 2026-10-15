// 拼多多联盟适配器的请求底座（4_PDD_附 §3.1–§3.4）：公共参数 + MD5 签名、凭据经构造参数注入、
// 经注入的 UnionTransport 发 POST JSON、按登记的外层键解包、error_response 分类到 UnionError。
// 订单端口（listOrders 的 increment / pay_time、getPddOrderDetail）的参数与映射在 orders.ts（B1-04i）；
// 其余端口的字段映射另开任务，目前一律 adapter_unimplemented（规划/11 §4.5）。
// 不读 process.env、不读文件；client_secret 只在内存里参与签名。
import type { Clock } from '../../../platform/index.ts';
import {
  UnionError,
  type CallCtx,
  type ConvertReq,
  type ConvertResult,
  type ItemRef,
  type MaterialReq,
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
import {
  incrementCursor,
  incrementWindow,
  lastOrderId,
  mapPddOrder,
  orderList,
  parseIncrementCursor,
  parseRangeCursor,
  PDD_INCREMENT_MAX_PAGE,
  PDD_INCREMENT_PAGE_SIZE,
  PDD_ORDER_DETAIL,
  PDD_ORDER_INCREMENT,
  PDD_ORDER_RANGE,
  rangeCursor,
  rangeWindow,
} from './orders.ts';

export interface PddCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** D-u2：服务端提供已备案的查询身份；customParameters 是不超过 64 字节的 JSON。 */
export interface PddQueryIdentity {
  readonly pid: string;
  readonly customParameters: string;
}

export interface PddAdapterOptions {
  readonly credentials: () => Promise<PddCredentials>;
  readonly transport: UnionTransport;
  readonly clock: Clock;
  readonly endpoint: UnionEndpoint;
  readonly warn?: (event: PddWarning) => void;
  readonly queryIdentity?: () => Promise<PddQueryIdentity>;
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

  /** B1-04u：精选频道固定为 4；分页游标的编码由实现阶段记录在此。 */
  async materialFeed(req: MaterialReq, ctx: CallCtx): Promise<Page<UnionItem>> {
    void req;
    void ctx;
    throw new Error('NotImplemented: materialFeed');
  }

  async convert(req: ConvertReq, identity: UnionIdentity, ctx: CallCtx): Promise<ConvertResult> {
    void req;
    void identity;
    void ctx;
    throw unimplemented('convert');
  }

  /**
   * 不传 queryMode = increment（按更新时间，倒序翻页）；pay_time 按支付时间用 last_order_id 迭代。
   * 时间窗与游标在取凭据、发请求之前校验，不合法报 invalid_dto。游标编码见 orders.ts。
   */
  async listOrders(win: TimeWindow, opt: OrderQueryOpt, ctx: CallCtx): Promise<Page<UnionOrder>> {
    const mode = opt?.queryMode ?? 'increment';
    if (mode === 'pay_time') return await this.#listByPayTime(win, opt.cursor, ctx.signal);
    if (mode !== 'increment') {
      throw new UnionError('invalid_dto', 'pdd listOrders: unknown queryMode', 'pdd');
    }
    return await this.#listIncrement(win, opt?.cursor, ctx.signal);
  }

  async #listIncrement(
    win: TimeWindow,
    cursor: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Page<UnionOrder>> {
    const window = incrementWindow(win, this.#clock.now().getTime());
    const fetched = new Map<number, readonly unknown[]>();
    const fetchPage = async (page: number): Promise<readonly unknown[]> => {
      const cached = fetched.get(page);
      if (cached !== undefined) return cached;
      const envelope = await this.request(
        PDD_ORDER_INCREMENT,
        { ...window, page, page_size: PDD_INCREMENT_PAGE_SIZE, return_count: false },
        signal,
      );
      const rows = orderList(envelope);
      fetched.set(page, rows);
      return rows;
    };
    const pageOf = (page: number, rows: readonly unknown[]): Page<UnionOrder> => ({
      items: rows.map((row) => mapPddOrder(row, 'increment')),
      nextCursor: page > 1 ? incrementCursor(page - 1) : null,
    });

    if (cursor !== undefined) {
      const page = parseIncrementCursor(cursor);
      return pageOf(page, await fetchPage(page));
    }
    // 首次调用：不依赖 total_count，先倍增再二分探出最后一个非空页，从它开始往回取。
    const full = async (page: number): Promise<boolean> =>
      (await fetchPage(page)).length >= PDD_INCREMENT_PAGE_SIZE;
    if (!(await full(1))) return pageOf(1, await fetchPage(1));
    let lo = 1; // 已知满页
    let hi: number; // 已知不满（含空）的页
    for (;;) {
      if (lo >= PDD_INCREMENT_MAX_PAGE) {
        throw new UnionError(
          'invalid_dto',
          'pdd listOrders: increment window exceeds the page limit; split it',
          'pdd',
        );
      }
      const probe = Math.min(lo * 2, PDD_INCREMENT_MAX_PAGE);
      if (await full(probe)) {
        lo = probe;
      } else {
        hi = probe;
        break;
      }
    }
    while (hi - lo > 1) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (await full(mid)) lo = mid;
      else hi = mid;
    }
    const tail = (await fetchPage(hi)).length > 0 ? hi : lo;
    return pageOf(tail, await fetchPage(tail));
  }

  async #listByPayTime(
    win: TimeWindow,
    cursor: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Page<UnionOrder>> {
    const window = rangeWindow(win);
    const token = cursor === undefined ? undefined : parseRangeCursor(cursor);
    const envelope = await this.request(
      PDD_ORDER_RANGE,
      { ...window, ...(token === undefined ? {} : { last_order_id: token }) },
      signal,
    );
    const items = orderList(envelope).map((row) => mapPddOrder(row, 'range'));
    const next = lastOrderId(envelope);
    // 空批、没有迭代器、或迭代器原样不变都结束，避免死循环。
    const done = items.length === 0 || next === null || next === token;
    return { items, nextCursor: done ? null : rangeCursor(next) };
  }

  /** order.detail.get：按 order_sn 查一单，补售后状态 return_status；空白订单号不发请求。 */
  async getPddOrderDetail(orderSn: string, ctx: CallCtx): Promise<UnionOrder> {
    if (typeof orderSn !== 'string' || orderSn.trim() === '') {
      throw new UnionError('invalid_dto', 'pdd getPddOrderDetail: order_sn is blank', 'pdd');
    }
    const envelope = await this.request(PDD_ORDER_DETAIL, { order_sn: orderSn }, ctx.signal);
    return mapPddOrder(envelope, 'detail');
  }
}
