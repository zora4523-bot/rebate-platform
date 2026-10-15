// 拼多多联盟适配器的请求底座（4_PDD_附 §3.1–§3.4）：公共参数 + MD5 签名、凭据经构造参数注入、
// 经注入的 UnionTransport 发 POST JSON、按登记的外层键解包、error_response 分类到 UnionError。
// 订单端口（listOrders 的 increment / pay_time、getPddOrderDetail）的参数与映射在 orders.ts（B1-04i）；
// 商品端口（searchItems / getItem / resolveLink / materialFeed）的参数、游标与映射在 goods.ts（B1-04u），
// 每次调用都带服务端注入的查询身份（D-u2）；B1-04h 转链与备案端口当前仅为 NotImplemented 骨架。
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
  type PddAuthority,
  type PddAuthorityUrl,
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
  checkQueryIdentity,
  envelopeCount,
  envelopeListId,
  feedCursor,
  goodsRows,
  mapPddGoods,
  parseFeedCursor,
  parseSearchCursor,
  pddGoodsRef,
  PDD_FEED_CHANNEL,
  PDD_FEED_LIMIT,
  PDD_GOODS_DETAIL,
  PDD_GOODS_RECOMMEND,
  PDD_GOODS_SEARCH,
  PDD_SEARCH_PAGE_SIZE,
  PDD_URL_SHORT_PARSE,
  searchCursor,
  type PddGoodsSource,
  type PddQueryIdentity,
} from './goods.ts';
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

export type { PddQueryIdentity } from './goods.ts';

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

export class PddUnionAdapter implements UnionAdapter {
  readonly platform = 'pdd' as const;
  readonly #credentials: () => Promise<PddCredentials>;
  readonly #transport: UnionTransport;
  readonly #clock: Clock;
  readonly #endpoint: UnionEndpoint;
  readonly #warn: ((event: PddWarning) => void) | undefined;
  readonly #queryIdentity: (() => Promise<PddQueryIdentity>) | undefined;

  constructor(options: PddAdapterOptions) {
    if (options.endpoint.platform !== 'pdd') {
      throw new UnionError('invalid_endpoint', 'pdd adapter: endpoint is not for pdd', 'pdd');
    }
    this.#credentials = options.credentials;
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#endpoint = options.endpoint;
    this.#warn = options.warn;
    this.#queryIdentity = options.queryIdentity;
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

  /**
   * D-u2：每次商品调用读一次查询身份并校验；未注入报 upstream_rejected，非法报 invalid_identity，
   * 两者都不取凭据、不发请求。身份只来自服务端提供者，不读 ctx（app_id、headers）。
   */
  async #identity(
    port: string,
  ): Promise<{ readonly pid: string; readonly custom_parameters: string }> {
    if (this.#queryIdentity === undefined) {
      throw new UnionError('upstream_rejected', `pdd ${port}: no query identity configured`, 'pdd');
    }
    return checkQueryIdentity(await this.#queryIdentity());
  }

  #onAnomaly(method: string): () => void {
    return () =>
      this.#warn?.({ error_code: 'PRICE_ANOMALY', event: 'PRICE_ANOMALY', type: method });
  }

  #mapRows(rows: readonly unknown[], source: PddGoodsSource, method: string): UnionItem[] {
    const now = this.#clock.now();
    return rows.map((row) => mapPddGoods(row, source, now, this.#onAnomaly(method)));
  }

  /**
   * goods.search：keyword 原样传送，page 从 1 开始，page_size 固定 PDD_SEARCH_PAGE_SIZE。
   * 游标 `pdd-search:<page>:<list_id base64url>`（见 goods.ts），续页带 list_id；满页且未到 total_count 才给下一页。
   * 价格异常的商品照样返回（price_status='anomaly'），出不出卡由 catalog 决定。
   */
  async searchItems(q: SearchQuery, ctx: CallCtx): Promise<Page<UnionItem>> {
    if (typeof q?.keyword !== 'string' || q.keyword.trim() === '') {
      throw new UnionError('invalid_dto', 'pdd searchItems: keyword is blank', 'pdd');
    }
    const cursor = q.cursor === undefined ? undefined : parseSearchCursor(q.cursor);
    const identity = await this.#identity('searchItems');
    const page = cursor?.page ?? 1;
    const envelope = await this.request(
      PDD_GOODS_SEARCH,
      {
        keyword: q.keyword,
        page,
        page_size: PDD_SEARCH_PAGE_SIZE,
        ...(cursor?.listId == null ? {} : { list_id: cursor.listId }),
        ...identity,
      },
      ctx.signal,
    );
    const rows = goodsRows(envelope, 'search');
    const items = this.#mapRows(rows, 'search', PDD_GOODS_SEARCH);
    const total = envelopeCount(envelope, 'total_count');
    const more =
      rows.length >= PDD_SEARCH_PAGE_SIZE &&
      (total === null || page * PDD_SEARCH_PAGE_SIZE < total);
    const listId = envelopeListId(envelope) ?? cursor?.listId ?? null;
    return { items, nextCursor: more ? searchCursor(page + 1, listId) : null };
  }

  /** goods.detail：只按 goods_sign 请求（不传 goods_id）；空 goods_details 报 item_unavailable。 */
  async getItem(ref: ItemRef, ctx: CallCtx): Promise<UnionItemDetail> {
    const sign = ref?.goods_sign;
    if (ref?.platform !== 'pdd' || typeof sign !== 'string' || sign.trim() === '') {
      throw new UnionError('invalid_dto', 'pdd getItem: goods_sign is required', 'pdd');
    }
    const identity = await this.#identity('getItem');
    const envelope = await this.request(
      PDD_GOODS_DETAIL,
      { goods_sign: sign, ...identity },
      ctx.signal,
    );
    const rows = goodsRows(envelope, 'detail');
    if (rows.length === 0) {
      throw new UnionError('item_unavailable', 'pdd getItem: no goods detail returned', 'pdd');
    }
    return mapPddGoods(rows[0], 'detail', this.#clock.now(), this.#onAnomaly(PDD_GOODS_DETAIL));
  }

  /**
   * 链接识别：先以原链接作 goods.search keyword（probe：商品链接与进宝短链都能识别）；无结果且是
   * http(s) 链接时，用 url.short.parse 展开一次（参数 original_url，与 probe 一致；不带查询身份），
   * 展开结果非空且不同于原链接才再搜一次。最多 3 次请求。身份只取响应的 goods_id + goods_sign，
   * 不从 URL 数字补出。网关错误原样上抛；只有短链展开被平台拒绝（upstream_rejected）时视为识别不了。
   */
  async resolveLink(raw: string, ctx: CallCtx): Promise<ResolvedLink> {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new UnionError('link_unrecognized', 'pdd resolveLink: empty link', 'pdd');
    }
    const link = raw.trim();
    const identity = await this.#identity('resolveLink');
    const find = async (keyword: string): Promise<ResolvedLink | null> => {
      const envelope = await this.request(
        PDD_GOODS_SEARCH,
        { keyword, page: 1, page_size: PDD_SEARCH_PAGE_SIZE, ...identity },
        ctx.signal,
      );
      const rows = goodsRows(envelope, 'search');
      return rows.length === 0 ? null : { item: pddGoodsRef(rows[0]) };
    };
    const direct = await find(link);
    if (direct !== null) return direct;
    if (/^https?:\/\//i.test(link)) {
      let expanded: string | null = null;
      try {
        const envelope = await this.request(
          PDD_URL_SHORT_PARSE,
          { original_url: link },
          ctx.signal,
        );
        const value =
          typeof envelope === 'object' && envelope !== null
            ? (envelope as Record<string, unknown>).url
            : undefined;
        expanded = typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
      } catch (error) {
        if (!(error instanceof UnionError) || error.code !== 'upstream_rejected') throw error;
      }
      if (expanded !== null && expanded !== link) {
        const second = await find(expanded);
        if (second !== null) return second;
      }
    }
    throw new UnionError('link_unrecognized', 'pdd resolveLink: no goods recognized', 'pdd');
  }

  /**
   * goods.recommend.get：固定精选 channel_type=4（PDD_FEED_CHANNEL），offset / limit 分页；
   * 游标 `pdd-feed:<offset>`（recommend 的 probe 响应没有 list_id）。满页且未到 total 才给下一页。
   */
  async materialFeed(req: MaterialReq, ctx: CallCtx): Promise<Page<UnionItem>> {
    const offset = req?.cursor === undefined ? 0 : parseFeedCursor(req.cursor);
    const identity = await this.#identity('materialFeed');
    const envelope = await this.request(
      PDD_GOODS_RECOMMEND,
      { channel_type: PDD_FEED_CHANNEL, offset, limit: PDD_FEED_LIMIT, ...identity },
      ctx.signal,
    );
    const rows = goodsRows(envelope, 'feed');
    const items = this.#mapRows(rows, 'feed', PDD_GOODS_RECOMMEND);
    const total = envelopeCount(envelope, 'total');
    const more =
      rows.length >= PDD_FEED_LIMIT && (total === null || offset + PDD_FEED_LIMIT < total);
    return { items, nextCursor: more ? feedCursor(offset + PDD_FEED_LIMIT) : null };
  }

  async convert(req: ConvertReq, identity: UnionIdentity, ctx: CallCtx): Promise<ConvertResult> {
    void req;
    void identity;
    void ctx;
    throw new Error('NotImplemented: PddUnionAdapter.convert');
  }

  async queryPddAuthority(identity: UnionIdentity, ctx: CallCtx): Promise<PddAuthority> {
    void identity;
    void ctx;
    throw new Error('NotImplemented: PddUnionAdapter.queryPddAuthority');
  }

  async pddAuthorityUrl(identity: UnionIdentity, ctx: CallCtx): Promise<PddAuthorityUrl> {
    void identity;
    void ctx;
    throw new Error('NotImplemented: PddUnionAdapter.pddAuthorityUrl');
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
