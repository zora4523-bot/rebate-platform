// 淘宝官方搜索 taobao.tbk.dg.material.optional.upgrade（B1-04zx，D10-504 / D10-582；BR-PRICE-01、
// BR-PRICE-11）。骨架：本轮只有类型，口径如下，实现轮照此填写（规则测试
// test/spec/union/taobao-official-search/**）。
//
// 开关：searchSource 为 official（未设也是）且注入了 searchSlot 时 searchItems 走官方；没有 searchSlot
// 保持 adapter_unimplemented，不取凭据、不发请求（冻结用例 AC-B1-04zh#8、AC-B1-04zn#8 / #14 都是有淘宝
// 凭据、没有这个端口）。dataoke 行为不变，不读 searchSlot。
//
// ① 请求：业务参数只有 q（SearchQuery.keyword 原样）、page_no、page_size 20、adzone_id；不传 sort。
//   adzone_id 取 searchSlot 给出的 query 场景 PID 第 3 段（mm_<member>_<site>_<adzone> 的 adzone，只作
//   请求参数，返回的链接不用；BR-PROD-07）；searchSlot 给 null → adapter_unimplemented，不发请求。空白
//   关键词 invalid_dto，不发请求。归档 kind = query；ctx.signal 原样带上。
// ② 游标：taobao-search:<页码>；大淘客、别的接口的游标与畸形游标都 invalid_dto，不发请求。下一页：
//   本页原始条数（跳过 / 换不到的照样计数）满 20 且（页码 × 20 < total_results，缺失时只看满页）。
//   空页 { items: [], nextCursor: null }，不调换算。
// ③ 映射逐字段挑，不 spread：title；三价走 mapTaobaoPrice（与 mapTaobaoDetail 同样字段时结果相等，
//   价格配置同样按 ctx.appId 读，优惠时间窗与 quoted_at 同一时刻判）；commission_rate_bp；类目；图片；
//   quoted_at = 收到搜索响应时的注入时钟。不外露 click_url、coupon_share_url、commission_amount、
//   搜索 item_id。金额解析同详情（JSON number 先转最短十进制串再解析，不用浮点乘 100，不舍入）。
// ④ 商品 ID：搜索 item_id 经 item.info.upgrade.get 换成详情口径（一页一次批量，缓存命中不再调）。
//   换算结果按 item_id 最后一段（deriveProductKey 同口径）与搜索 ID 匹配，不按位置：乱序、少条都能
//   各得其所；最后一段对不上的不返回、不写缓存，不用搜索 ID 兜底。
// ⑤ 价格不合格不跳行：字段缺失、非法文本、coupon ≥ price、final ≤ 0、calc_diff、unknown_promo、优惠
//   不在时间窗内都与详情一样出 price_status = 'anomaly'，三价 0，留在 items 里，不废页。
// ⑥ 跳行只有缺标题、佣金非法、换不到 ID（含搜索 item_id 本身不合格）：经 searchWarn 发
//   taobao_search_row_skipped，字段只有 reason，不含取值；不走适配器 warn（那是 API 权限告警）。
//   整页每行都因缺标题或佣金非法而跳过 → invalid_dto（不调换算）；换不到不算非法，本页照常返回。
// ⑦ 外层：外层键缺失或不是对象 → upstream_unavailable（request() 的做法）；result_list / map_data
//   损坏 → invalid_dto；code 11 → upstream_rejected。
import type { CallCtx } from '../../domain/types.ts';

/** The TOP method of the official material search. */
export type TaobaoOfficialSearchMethod = 'taobao.tbk.dg.material.optional.upgrade';

/** The response envelope key registered for that method. */
export type TaobaoOfficialSearchEnvelope = 'tbk_dg_material_optional_upgrade_response';

/** Rows asked per search page (page_size). */
export type TaobaoOfficialSearchPageSize = 20;

/**
 * The calling app's active Taobao query PID (mm_<member>_<site>_<adzone>), or null when it has
 * none. Called with the searchItems CallCtx, before the search request; the adzone only fills the
 * request parameter.
 */
export type TaobaoSearchSlotReader = (ctx: CallCtx) => Promise<string | null>;

/** Why a search row was left out of the result. */
export type TaobaoSearchSkipReason = 'title_missing' | 'commission_invalid' | 'item_unconverted';

/** One skipped search row; carries no value of that row. */
export interface TaobaoSearchWarning {
  readonly event: 'taobao_search_row_skipped';
  readonly reason: TaobaoSearchSkipReason;
}
