// 淘宝 searchItems 经大淘客搜索（B1-04zh，D10-503 ② / D10-504 / D10-515 / D10-525）。骨架：本轮只有
// 类型与只抛 NotImplemented 的函数，口径如下，实现轮照此填写（规则测试 test/spec/union/taobao-search/**）。
//
// 开关：TaobaoAdapterOptions.searchSource（见 taobao-adapter.ts）。只有 'dataoke' 且注入了 orderSource
// （大淘客客户端）时 searchItems 才经大淘客；缺省、'official' 或没有 orderSource → 保持
// adapter_unimplemented，不取凭据、不发请求。
//
// ① 搜索请求：经 orderSource GET /api/goods/get-dtk-search-goods，version v2.1.2；业务参数只有
//   keyWords = SearchQuery.keyword 原样、pageId（首页 1，续页由 cursor 承载）、pageSize 20、sort 0。
//   归档 kind = query；ctx.signal 原样带上。
// ② 游标：照拼多多 searchCursor 的做法，带本接口自己的前缀与页码（关键词不进游标，由调用方续传）；
//   畸形游标、别的接口的游标（含 pdd-search / pdd-feed）、空串 → invalid_dto，不取凭据、不发请求。
//   下一页：本页原始条数（data.list 的长度，跳过 / 换不到的条目照样计数）满 20 且 pageId × 20 < totalNum
//   （totalNum 缺失 / 非法时只看满页）才给 nextCursor，否则 null。list 为空 → { items: [], nextCursor: null }，
//   不调换算。
// ③ 商品 ID 换算（D10-504）：大淘客 goodsId 与凑狸应用口径的 item_id 前后段都不同，绝不用作 item_id，
//   也不出现在结果的任何字段里。同页待换算的 goodsId（缓存未命中的，按搜索顺序、去掉被跳过的条目）
//   每批 ≤ 20 个，经淘宝底座 request 调 taobao.tbk.item.info.upgrade.get：业务参数只有
//   item_id = 逗号连接的 goodsId、biz_scene_id = 1；外层键 tbk_item_info_upgrade_get_response，results
//   按 goods.ts detailRows 的单键包装解包；归档 kind = query；ctx.signal 原样带上。
//   对应规则（matchConvertedItemIds）：返回条数与本批请求条数相等时按位置对应（第 i 条的 item_id 是第 i
//   个 goodsId 的凑狸 ID；该条 item_id 缺失 / 非字符串 / 空白 → 只丢这一条）；条数不等时按顺序无法对应，
//   本批里的每个 goodsId 改为一次只请求一个再换（一个对一个）。15/50001、results 为空 → 本批（或这一个）
//   换不到。换不到的条目不返回（相当于商品暂不可用），不用大淘客 ID 兜底，也不写缓存。
//   含逗号、空白或缺失的 goodsId 不进请求（该条按 invalid_item 跳过）。
// ④ 映射缓存：进程内、每个适配器实例一份，goodsId → 凑狸 item_id，带 TTL（实现轮定，必须远小于一年），
//   时间只读注入的 Clock。命中不再调 TOP；只缓存换算成功的结果。
// ⑤ 映射（mapDataokeSearchItem）：逐个挑字段，从不 spread。item_id = 换算后的凑狸 ID；title = title
//   （非空白字符串），否则 dtitle；主图 / 多图经 normalizeItemImages（main_image_url = mainPic，
//   image_urls = smallImages 有效项）；quoted_at = 收到搜索响应（不是换算响应）时的注入 Clock。
//   一级类目字段不填。不映射不外露：estimateAmount、couponLink、itemLink、大淘客 id、goodsSign、
//   sellerId、goodsId。
//   价格（BR-PRICE-01，D10-515 / D10-525；券前价口径按编排 D10-530）：price_fen = actualPrice +
//   couponPrice，coupon_fen = couponPrice（无券为 0），final_price_fen = actualPrice（即 price_fen −
//   coupon_fen）；originalPrice 只存不进三价（它缺失 / 非法、或与 actualPrice + couponPrice 不一致，
//   都不影响三价、不算价格异常）。
//   元转分只经 @couli/domain parseYuanToFen：字符串原样交它，有限 JSON number 先 String() 再交它；
//   actualPrice / couponPrice 缺失 / 非法、或结果触发 isPriceAnomaly 的基本条件（price > 0、
//   0 ≤ coupon < price、final > 0）→ 照样返回该条，price_status = 'anomaly'，三价都是 0n（不出截断值），
//   金额缺失 / 非法时 price_anomaly_reason = 'missing_field'，并告警 PRICE_ANOMALY。
//   commission_rate_bp = @couli/money pctStrToBp(commissionRate)（number 先 String()，超两位小数按十进制
//   floor：20.556 → 2055、0.019 → 1）；缺失 / 非法 → 跳过该条并告警 invalid_commission。goodsId / 标题（title 与 dtitle 都没有）/ 主图缺失或不合格 →
//   跳过该条并告警 invalid_item。跳过不整页失败，结果保持搜索顺序。
// 告警：经适配器 warn，形如 { method: '/api/goods/get-dtk-search-goods', code: DataokeSearchWarningCode }，
//   只带路径与固定码，不带商品 ID、标题、金额、链接等原值。
import type { Clock } from '../../../platform/index.ts';
import type { UnionItemDetail } from '../../domain/types.ts';
import type { DataokeParameters } from '../dataoke/dataoke-client.ts';
import type { TaobaoWarning } from './response.ts';

/** The request path of the 大淘客 goods search. */
export type DataokeSearchPath = '/api/goods/get-dtk-search-goods';

/** The interface version of the 大淘客 goods search. */
export type DataokeSearchVersion = 'v2.1.2';

/** Rows asked per search page (pageSize). */
export type DataokeSearchPageSize = 20;

/** At most this many goodsIds per taobao.tbk.item.info.upgrade.get call. */
export type TaobaoItemIdBatchSize = 20;

/** The fixed codes a search warning may carry (see the header). */
export type DataokeSearchWarningCode =
  | 'PRICE_ANOMALY'
  | 'PRICE_CALC_DIFF'
  | 'invalid_item'
  | 'invalid_commission';

/** The `data` of one search response, reduced to what paging needs. */
export interface DataokeSearchPage {
  /** data.list as given (one entry per upstream row, valid or not). */
  readonly rows: readonly unknown[];
  /** data.totalNum when a non-negative safe integer, else null. */
  readonly totalNum: number | null;
}

/** One row that passed the goodsId / title / image / commission checks, before conversion. */
export interface DataokeSearchCandidate {
  readonly goodsId: string;
  readonly row: Readonly<Record<string, unknown>>;
}

/** Process-local goodsId → 凑狸 item_id map with a TTL read from the injected Clock. */
export interface TaobaoItemIdCache {
  /** The cached item_id while its entry is younger than the TTL, else undefined. */
  get(goodsId: string): string | undefined;
  /** Records a successful conversion only. */
  set(goodsId: string, itemId: string): void;
}

/** The opaque cursor of search page `page` (≥ 2). */
export function dataokeSearchCursor(page: number): string {
  void page;
  throw new Error('NotImplemented: dataokeSearchCursor');
}

/** The page a cursor of this search carries; anything else → invalid_dto. */
export function parseDataokeSearchCursor(cursor: string): number {
  void cursor;
  throw new Error('NotImplemented: parseDataokeSearchCursor');
}

/** Business parameters keyWords / pageId / pageSize / sort of one search request. */
export function dataokeSearchParameters(keyword: string, page: number): DataokeParameters {
  void keyword;
  void page;
  throw new Error('NotImplemented: dataokeSearchParameters');
}

/** data.list and data.totalNum of a search response. */
export function dataokeSearchPage(data: Readonly<Record<string, unknown>>): DataokeSearchPage {
  void data;
  throw new Error('NotImplemented: dataokeSearchPage');
}

/** nextCursor from the raw row count of this page (see the header ②). */
export function dataokeSearchNextCursor(
  page: number,
  rawCount: number,
  totalNum: number | null,
): string | null {
  void page;
  void rawCount;
  void totalNum;
  throw new Error('NotImplemented: dataokeSearchNextCursor');
}

/** Rows that may be returned, in search order; the others are skipped with one warning each. */
export function dataokeSearchCandidates(
  rows: readonly unknown[],
  warn: ((event: TaobaoWarning) => void) | undefined,
): readonly DataokeSearchCandidate[] {
  void rows;
  void warn;
  throw new Error('NotImplemented: dataokeSearchCandidates');
}

/** goodsIds split into request batches of at most TaobaoItemIdBatchSize, order kept. */
export function taobaoItemIdBatches(goodsIds: readonly string[]): readonly (readonly string[])[] {
  void goodsIds;
  throw new Error('NotImplemented: taobaoItemIdBatches');
}

/**
 * goodsId → 凑狸 item_id for one batch by position (see the header ③); null when the row count
 * differs from the batch size (the batch is then converted one goodsId per request).
 */
export function matchConvertedItemIds(
  goodsIds: readonly string[],
  rows: readonly unknown[],
): ReadonlyMap<string, string> | null {
  void goodsIds;
  void rows;
  throw new Error('NotImplemented: matchConvertedItemIds');
}

/** A goodsId → item_id cache over the injected Clock. */
export function createTaobaoItemIdCache(clock: Clock): TaobaoItemIdCache {
  void clock;
  throw new Error('NotImplemented: createTaobaoItemIdCache');
}

/**
 * One candidate row → UnionItemDetail under the converted `itemId`; `receivedAt` is the Clock read
 * when the search response arrived. Price anomalies stay in the result (price_status 'anomaly').
 */
export function mapDataokeSearchItem(
  candidate: DataokeSearchCandidate,
  itemId: string,
  receivedAt: Date,
  warn: ((event: TaobaoWarning) => void) | undefined,
): UnionItemDetail {
  void candidate;
  void itemId;
  void receivedAt;
  void warn;
  throw new Error('NotImplemented: mapDataokeSearchItem');
}
