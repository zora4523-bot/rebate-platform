// 拼多多转链与备案（B1-04h；BR-ID-22、BR-ATTR-05/06、BR-PRICE-02 细则 G-48，09 4_PDD CAP-PDD-05/06）：
// goods.promotion.url.generate（转链）、member.authority.query（备案查询）、
// rp.prom.url.generate channel_type=10（备案链接）的请求参数与出参映射。
// 映射只读任务书 probe 字段清单里的字段，逐个挑出，从不 spread 整份报文；清单外字段
// （如 we_app_info、weixin_short_link）一律不映射。
// 三个接口都用 linking 在服务端构造的身份：p_id / pid 取 identity.promotionSlot（备案按推广位分开，
// 裁定 D-u3），custom_parameters 按原对象序列化，不重排、不补键、不删键，也不从 userId 重建 uid。
import {
  isServerIdentity,
  UnionError,
  type ConvertResult,
  type ItemRef,
  type PddAuthorityUrl,
  type PddPromotionUrlExtras,
  type UnionIdentity,
} from '../../domain/types.ts';

export const PDD_PROMOTION_URL_GENERATE = 'pdd.ddk.goods.promotion.url.generate';
export const PDD_AUTHORITY_QUERY = 'pdd.ddk.member.authority.query';
export const PDD_RP_PROM_URL_GENERATE = 'pdd.ddk.rp.prom.url.generate';

/** rp.prom.url.generate 的备案频道（CAP-PDD-05/06）。 */
export const PDD_AUTHORITY_CHANNEL = 10;

/** custom_parameters 按 UTF-8 字节计不超过 64（BR-ID-22）；超长报错，不截断。 */
const MAX_CUSTOM_PARAMETERS_BYTES = 64;

/**
 * union 侧对 linking 身份子类的局部结构声明（不 import linking）：custom_parameters 是
 * {app, uid?, sc, lk?} 一类的扁平字符串对象；no_rebate 时没有 uid（BR-ATTR-06）。
 */
type WithCustomParameters = UnionIdentity & { readonly custom_parameters?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 转链 / 备案用的推广位与 custom_parameters 文本；在取凭据、发请求之前同步校验。 */
export interface PddIdentityParameters {
  readonly promotionSlot: string;
  readonly customParameters: string;
}

export function pddIdentityParameters(
  identity: UnionIdentity,
  port: string,
): PddIdentityParameters {
  const refuse = (reason: string) =>
    new UnionError('invalid_identity', `pdd ${port}: identity ${reason}`, 'pdd');
  if (!isServerIdentity(identity) || identity.claims.platform !== 'pdd') {
    throw refuse('is not a server-built pdd identity');
  }
  const slot = identity.claims.promotionSlot;
  if (typeof slot !== 'string' || slot.trim() === '') throw refuse('has no promotion slot');
  const parameters = (identity as WithCustomParameters).custom_parameters;
  if (!isRecord(parameters)) throw refuse('has no custom_parameters');
  for (const value of Object.values(parameters)) {
    if (typeof value !== 'string') throw refuse('custom_parameters is not flat text');
  }
  // 原对象原样序列化：键序即 linking 构造时的键序。
  const text = JSON.stringify(parameters);
  if (new TextEncoder().encode(text).length > MAX_CUSTOM_PARAMETERS_BYTES) {
    throw new UnionError('invalid_dto', `pdd ${port}: custom_parameters exceeds 64 bytes`, 'pdd');
  }
  return { promotionSlot: slot, customParameters: text };
}

/** 转链只认一个拼多多 goods_sign（一次 1 个；goods_id、search_id、sku_id_code_list 都不传）。 */
export function convertGoodsSign(item: ItemRef | undefined): string {
  const sign = item?.goods_sign;
  if (item?.platform !== 'pdd' || typeof sign !== 'string' || sign.trim() === '') {
    throw new UnionError('invalid_dto', 'pdd convert: goods_sign is required', 'pdd');
  }
  return sign;
}

// ---- 出参映射 -----------------------------------------------------------------------------

function unavailable(method: string, reason: string): UnionError {
  return new UnionError('upstream_unavailable', `pdd ${method}: ${reason}`, 'pdd');
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.hostname !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

const BLOCKED_SCHEMES: ReadonlySet<string> = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
]);

/** App scheme 链接（如 pinduoduo://）；脚本类 scheme 丢弃。 */
function appScheme(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\/\S/i.test(value)) return undefined;
  const scheme = value.slice(0, value.indexOf(':') + 1).toLowerCase();
  return BLOCKED_SCHEMES.has(scheme) ? undefined : value;
}

/** 首行：外层下的列表须为非空数组且首元素是对象，否则是上游未给出可用结果。 */
function firstRow(envelope: unknown, listKey: string, method: string): Record<string, unknown> {
  const list = isRecord(envelope) ? envelope[listKey] : undefined;
  if (!Array.isArray(list) || list.length === 0 || !isRecord(list[0])) {
    throw unavailable(method, `no ${listKey} row in response`);
  }
  return list[0];
}

/** 主地址：mobile_url，缺失用 mobile_short_url；必须是 https（linking 把它当 universal link 与 h5 用）。 */
function mainUrl(row: Record<string, unknown>, method: string): string {
  const candidate =
    typeof row.mobile_url === 'string' && row.mobile_url !== ''
      ? row.mobile_url
      : row.mobile_short_url;
  const url = httpsUrl(candidate);
  if (url === undefined) throw unavailable(method, 'no https mobile url in response');
  return url;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** 只挑选给出的 probe 字段；非 https / 脚本 scheme 的值丢弃，缺失的不补。 */
function extras(
  row: Record<string, unknown>,
  fields: readonly (readonly [keyof PddPromotionUrlExtras, string, 'https' | 'scheme'])[],
): PddPromotionUrlExtras {
  const out: Mutable<PddPromotionUrlExtras> = {};
  for (const [target, source, kind] of fields) {
    const value = kind === 'https' ? httpsUrl(row[source]) : appScheme(row[source]);
    if (value !== undefined) out[target] = value;
  }
  return out;
}

/**
 * goods.promotion.url.generate 的 probe 附加字段。上游 `url` 是浏览器里优先拉起微信小程序的
 * 入口，改名 browser_url，以免与 ConvertResult.url（mobile_url）冲突。
 */
const CONVERT_EXTRAS = [
  ['schema_url', 'schema_url', 'scheme'],
  ['tz_schema_url', 'tz_schema_url', 'scheme'],
  ['mobile_short_url', 'mobile_short_url', 'https'],
  ['browser_url', 'url', 'https'],
  ['short_url', 'short_url', 'https'],
  ['we_app_web_view_url', 'we_app_web_view_url', 'https'],
  ['we_app_web_view_short_url', 'we_app_web_view_short_url', 'https'],
] as const;

/** rp.prom.url.generate 两次 probe（scheme 版、短链版）出现过的附加字段。 */
const AUTHORITY_URL_EXTRAS = [
  ['schema_url', 'schema_url', 'scheme'],
  ['mobile_short_url', 'mobile_short_url', 'https'],
  ['browser_url', 'url', 'https'],
  ['short_url', 'short_url', 'https'],
] as const;

export function mapConvertResult(envelope: unknown): ConvertResult {
  const method = PDD_PROMOTION_URL_GENERATE;
  const row = firstRow(envelope, 'goods_promotion_url_list', method);
  return { kind: 'url', url: mainUrl(row, method), ...extras(row, CONVERT_EXTRAS) };
}

export function mapAuthorityUrl(envelope: unknown): PddAuthorityUrl {
  const method = PDD_RP_PROM_URL_GENERATE;
  const row = firstRow(envelope, 'url_list', method);
  return { url: mainUrl(row, method), ...extras(row, AUTHORITY_URL_EXTRAS) };
}

/** authority_query_response.bind：只有整数 1 算已备案，其他（0、缺失、字符串、布尔）都算未备案。 */
export function mapAuthorized(envelope: unknown): boolean {
  if (!isRecord(envelope)) {
    throw unavailable(PDD_AUTHORITY_QUERY, 'unexpected authority_query_response');
  }
  return envelope.bind === 1;
}
