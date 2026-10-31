// 淘宝转链经大淘客高效转链（B1-04d，D10-503 ①）：GET /api/tb-service/get-privilege-link，
// version v1.3.1，经 TaobaoUnionAdapter 的 orderSource（DataokeClient，签名与错误分类沿用 B1-04m）。
// - 参数：goodsId = ConvertReq.item.item_id 原样（大淘客口径，D10-504；不是淘宝商品、缺失 / 空白 →
//   invalid_dto）；pid = identity.claims.promotionSlot（linking 已选好，BR-ATTR-08；空白 →
//   invalid_identity）；channelId = identity.claims.relationId（非空字符串才带；null 是 linking 判定后
//   的 no_rebate 路径，不带；空串或非字符串 → invalid_identity）。身份不是服务端构造的淘宝身份 →
//   invalid_identity。couponId / specialId / externalId / rebateType 不带。入参不合格不取凭据、不发请求。
// - 错误：外层 code 10031 / 10212 / 10213（数字与同值字符串同等）→ item_unavailable；其余照 B1-04m；
//   data 缺失或非对象 → upstream_unavailable。
// - 出参：见 domain/types.ts TaobaoPromotionUrlExtras / TaobaoRequote；逐个挑字段，从不 spread。
// 本文件现在只是骨架：常量（路径、版本、错误码表）留给实现。
import type { ConvertReq, ConvertResult, UnionIdentity } from '../../domain/types.ts';
import type { DataokeParameters } from '../dataoke/dataoke-client.ts';
import type { TaobaoWarning } from './response.ts';

/** The request path of the 大淘客 privilege link. */
export type DataokePrivilegeLinkPath = '/api/tb-service/get-privilege-link';

/** The interface version of the 大淘客 privilege link. */
export type DataokePrivilegeLinkVersion = 'v1.3.1';

/**
 * Business parameters (goodsId, pid, optional channelId) for one conversion, checked before any
 * credential is fetched or request sent.
 */
export function privilegeLinkParameters(
  req: ConvertReq,
  identity: UnionIdentity,
): DataokeParameters {
  void req;
  void identity;
  throw new Error('NotImplemented: privilegeLinkParameters');
}

/**
 * The response `data` → ConvertResult kind 'url' with the Taobao extras; `receivedAt` is the
 * injected Clock read after the response arrived (requote.quoted_at).
 */
export function mapPrivilegeLink(
  data: Readonly<Record<string, unknown>>,
  receivedAt: Date,
  warn: ((event: TaobaoWarning) => void) | undefined,
): ConvertResult {
  void data;
  void receivedAt;
  void warn;
  throw new Error('NotImplemented: mapPrivilegeLink');
}
