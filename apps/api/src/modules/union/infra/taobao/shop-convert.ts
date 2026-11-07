// 淘宝店铺转链经大淘客店铺转链（B1-04zzt，S-17 S17-u2，D10-806）：GET /api/dels/shop/convert，
// version v1.0.0，经 TaobaoUnionAdapter 的 orderSource（DataokeClient，签名与错误分类沿用 B1-04m）。
// - 参数：sellerId = ShopConvertReq.shopRef（正整数十进制串，不合格 → 拒绝不发请求）；shopName 必填
//   （空白 → 拒绝不发请求）；pid = identity.claims.promotionSlot（缺 → invalid_identity）；relationId =
//   identity.claims.relationId（null 也拒绝：进店没有「无返利」路径）。authId 不带。入参不合格不取凭据、
//   不发请求。
// - 出参：code 0 且 shopLinks 是 https、主机属淘宝联盟 → { url: shopLinks, tpwd?, longTpwd? }；tpwd 字段名
//   大小写兼容（tpwd / Tpwd）。缺 shopLinks、非 https、主机不符、code 非 0、非 JSON、HTTP 非 2xx →
//   upstream_unavailable，从不返回无推广参数的地址；错误信息不带 pid、relationId 与链接原文。
// - 归档 kind = convert（同商品转链）。
import type { ShopConvertReq, ShopConvertResult, UnionIdentity } from '../../domain/types.ts';
import type { DataokeExchange, DataokeParameters } from '../dataoke/dataoke-client.ts';

/** The request path of the 大淘客 shop convert. */
export type DataokeShopConvertPath = '/api/dels/shop/convert';

/** The interface version of the 大淘客 shop convert. */
export type DataokeShopConvertVersion = 'v1.0.0';

/**
 * Business parameters (sellerId, pid, shopName, relationId) of one shop conversion, checked before
 * any credential is fetched or request sent.
 */
export function shopConvertParameters(
  req: ShopConvertReq,
  identity: UnionIdentity,
): DataokeParameters {
  void req;
  void identity;
  throw new Error('NotImplemented: shopConvertParameters');
}

/** The 大淘客 answer (HTTP status and `data`) → ShopConvertResult, or upstream_unavailable. */
export function mapShopConvert(exchange: DataokeExchange): ShopConvertResult {
  void exchange;
  throw new Error('NotImplemented: mapShopConvert');
}
