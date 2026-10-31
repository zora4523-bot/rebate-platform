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
//   链接只认绝对 https（`//…`、http、无 scheme 都当作没有）；url = short_url，否则 coupon_click_url，
//   都没有 → upstream_unavailable。kuaiZhanUrl / itemUrl / itemId / title / 佣金比例不映射。
// - requote：originalPrice / actualPrice 只经 @couli/domain 的 parseYuanToFen（BR-PRICE-01，
//   D10-515 / D10-525）；有限 JSON number 先 String() 成最短十进制字符串再交它，字符串原样交它。
//   缺失 / null 静默省略整个 requote；给了但 parseYuanToFen 不收（超过两位小数、负数、指数、
//   空白、NaN / Infinity、其他类型等）→ 省略整个 requote 并经适配器 warn 告警一次
//   （method = 请求路径，code = invalid_amount，不带原值），不影响转链结果。
import { parseYuanToFen } from '@couli/domain';
import {
  isServerIdentity,
  UnionError,
  type ConvertReq,
  type ConvertResult,
  type TaobaoPromotionUrlExtras,
  type TaobaoRequote,
  type UnionIdentity,
} from '../../domain/types.ts';
import type { DataokeCodeMap, DataokeParameters } from '../dataoke/dataoke-client.ts';
import type { TaobaoWarning } from './response.ts';

/** The request path of the 大淘客 privilege link. */
export type DataokePrivilegeLinkPath = '/api/tb-service/get-privilege-link';

/** The interface version of the 大淘客 privilege link. */
export type DataokePrivilegeLinkVersion = 'v1.3.1';

export const DATAOKE_PRIVILEGE_LINK_PATH: DataokePrivilegeLinkPath =
  '/api/tb-service/get-privilege-link';
export const DATAOKE_PRIVILEGE_LINK_VERSION: DataokePrivilegeLinkVersion = 'v1.3.1';

/** gz-13 商品不可推广类外层 code：未查询到相关商品 / 联盟商品不存在 / 联盟优惠券已过期。 */
export const DATAOKE_PRIVILEGE_LINK_CODES: DataokeCodeMap = Object.freeze({
  '10031': 'item_unavailable',
  '10212': 'item_unavailable',
  '10213': 'item_unavailable',
});

/** The warning code for an invalid originalPrice / actualPrice (requote dropped). */
export const INVALID_AMOUNT_WARNING = 'invalid_amount';

const PORT = 'convert';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Business parameters (goodsId, pid, optional channelId) for one conversion, checked before any
 * credential is fetched or request sent.
 */
export function privilegeLinkParameters(
  req: ConvertReq,
  identity: UnionIdentity,
): DataokeParameters {
  const refuse = (reason: string) =>
    new UnionError('invalid_identity', `taobao ${PORT}: identity ${reason}`, 'taobao');
  if (!isServerIdentity(identity) || identity.claims.platform !== 'taobao') {
    throw refuse('is not a server-built taobao identity');
  }
  const { promotionSlot, relationId } = identity.claims;
  if (!nonBlank(promotionSlot)) throw refuse('has no promotion slot');
  // null：linking 已判定的 no_rebate 路径，不带 channelId；空串 / 空白 / 非字符串不合格。
  if (relationId !== null && !nonBlank(relationId)) throw refuse('has an invalid relation id');

  const item = isRecord(req) ? req.item : undefined;
  const goodsId = isRecord(item) && item.platform === 'taobao' ? item.item_id : undefined;
  if (!nonBlank(goodsId)) {
    throw new UnionError('invalid_dto', `taobao ${PORT}: a taobao item_id is required`, 'taobao');
  }
  return relationId === null
    ? { goodsId, pid: promotionSlot }
    : { goodsId, pid: promotionSlot, channelId: relationId };
}

/** An absolute https URL as given; anything else (`//…`, http, no scheme, whitespace) is absent. */
function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^https:\/\/[^\s]+$/i.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function count(value: unknown): string | number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  return text(value);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * Fen of a present amount; undefined when absent / null; 'invalid' otherwise.
 * 08「金额解析」（BR-PRICE-01，D10-525）：实测 originalPrice / actualPrice 是 JSON float；有限 number
 * 先经 String() 转为最短十进制字符串，再与字符串走同一 parseYuanToFen：超过两位小数、符号、指数、
 * 空白都返回 null → 非法。NaN / Infinity 与其他类型也算非法。
 */
function amountFen(value: unknown): bigint | 'invalid' | undefined {
  if (value === undefined || value === null) return undefined;
  let amountText: string;
  if (typeof value === 'number' && Number.isFinite(value)) amountText = String(value);
  else if (typeof value === 'string') amountText = value;
  else return 'invalid';
  return parseYuanToFen(amountText) ?? 'invalid';
}

function requoteOf(
  data: Readonly<Record<string, unknown>>,
  receivedAt: Date,
  warn: ((event: TaobaoWarning) => void) | undefined,
): TaobaoRequote | undefined {
  const price = amountFen(data.originalPrice);
  const finalPrice = amountFen(data.actualPrice);
  if (price === 'invalid' || finalPrice === 'invalid') {
    // 只带路径与固定码，不带原值。
    warn?.({ method: DATAOKE_PRIVILEGE_LINK_PATH, code: INVALID_AMOUNT_WARNING });
    return undefined;
  }
  if (price === undefined || finalPrice === undefined) return undefined;
  const out: Mutable<TaobaoRequote> = {
    price_fen: price,
    final_price_fen: finalPrice,
    quoted_at: receivedAt.toISOString(),
  };
  const couponInfo = text(data.couponInfo);
  if (couponInfo !== undefined) out.coupon_info = couponInfo;
  const couponStart = text(data.couponStartTime);
  if (couponStart !== undefined) out.coupon_start_time = couponStart;
  const couponEnd = text(data.couponEndTime);
  if (couponEnd !== undefined) out.coupon_end_time = couponEnd;
  const total = count(data.couponTotalCount);
  if (total !== undefined) out.coupon_total_count = total;
  const remain = count(data.couponRemainCount);
  if (remain !== undefined) out.coupon_remain_count = remain;
  return out;
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
  if (!isRecord(data)) {
    throw new UnionError(
      'upstream_unavailable',
      `dataoke ${DATAOKE_PRIVILEGE_LINK_PATH}: response data is not an object`,
      'taobao',
    );
  }
  const shortUrl = httpsUrl(data.shortUrl);
  const couponClickUrl = httpsUrl(data.couponClickUrl);
  const url = shortUrl ?? couponClickUrl;
  if (url === undefined) {
    throw new UnionError(
      'upstream_unavailable',
      `dataoke ${DATAOKE_PRIVILEGE_LINK_PATH}: no https link in response`,
      'taobao',
    );
  }
  const extras: Mutable<TaobaoPromotionUrlExtras> = {};
  const tpwd = text(data.tpwd);
  if (tpwd !== undefined) extras.tpwd = tpwd;
  const longTpwd = text(data.longTpwd);
  if (longTpwd !== undefined) extras.long_tpwd = longTpwd;
  if (shortUrl !== undefined) extras.short_url = shortUrl;
  if (couponClickUrl !== undefined) extras.coupon_click_url = couponClickUrl;
  const requote = requoteOf(data, receivedAt, warn);
  if (requote !== undefined) extras.requote = requote;
  return { kind: 'url', url, ...extras };
}
