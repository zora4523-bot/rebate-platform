// 淘宝推广链接的两个可选端口（B1-04l，② 段）：淘口令 taobao.tbk.tpwd.create 与长链转短链
// taobao.tbk.spread.get 的入参白名单与应答解析（已录形状，见任务书第 9 节）。
// 入参只收 https、默认端口、无用户信息、主机名在白名单内的链接，否则 invalid_dto（不取凭据、不发请求）。
// 应答只读 data.password_simple / data.model 与 results 包装下第一项的 content / err_msg。
import { UnionError, type TaobaoShareCode, type UnionErrorCode } from '../../domain/types.ts';
import type { TaobaoSubCodeMap } from './response.ts';

export const TAOBAO_TPWD_CREATE = 'taobao.tbk.tpwd.create';
export const TAOBAO_TPWD_CREATE_ENVELOPE = 'tbk_tpwd_create_response';
export const TAOBAO_SPREAD_GET = 'taobao.tbk.spread.get';
export const TAOBAO_SPREAD_GET_ENVELOPE = 'tbk_spread_get_response';

/** 淘口令只能由我方推广链接生成（BR-ATTR-10）。 */
const SHARE_HOSTS: ReadonlySet<string> = new Set(['s.click.taobao.com', 'uland.taobao.com']);
/** spread.get 手册列出的四个域名。 */
const SPREAD_HOSTS: ReadonlySet<string> = new Set([
  'uland.taobao.com',
  's.click.taobao.com',
  'ai.taobao.com',
  'temai.taobao.com',
]);
const SHORT_LINK_PREFIX = 'https://s.click.taobao.com/';
const MAX_LINK_LENGTH = 4096;

/** tpwd.create 的 15 细分：26 链接不属联盟官方场景、23 物料为空。 */
export const TAOBAO_TPWD_SUB_CODES: TaobaoSubCodeMap = Object.freeze({
  '26': 'link_unrecognized',
  '23': 'link_unrecognized',
} satisfies Record<string, UnionErrorCode>);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whitespace or a C0 / DEL / C1 control character. */
function hasBlankOrControl(value: string): boolean {
  if (/\s/u.test(value)) return true;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** An https link on one of `hosts` exactly (no port, no userinfo), passed on unchanged. */
function isAllowedLink(value: unknown, hosts: ReadonlySet<string>): value is string {
  if (typeof value !== 'string' || value.length > MAX_LINK_LENGTH) return false;
  if (!value.startsWith('https://') || hasBlankOrControl(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return false;
  }
  // 原文的主机段也必须正是白名单主机（不靠 URL 解析的大小写 / 编码归一）。
  const authority = value.slice('https://'.length).split(/[/?#]/u, 1)[0];
  return hosts.has(url.hostname) && authority === url.hostname;
}

function invalidLink(operation: string): UnionError {
  return new UnionError('invalid_dto', `taobao ${operation}: link is not accepted`, 'taobao');
}

/** taobaoShareCode 的入参：https 的 s.click / uland 链接，否则 invalid_dto。 */
export function checkShareLink(url: unknown): string {
  if (!isAllowedLink(url, SHARE_HOSTS)) throw invalidLink('taobaoShareCode');
  return url;
}

/** shortenTaobaoUrl 的入参：https 的 uland / s.click / ai / temai 链接，否则 invalid_dto。 */
export function checkSpreadLink(url: unknown): string {
  if (!isAllowedLink(url, SPREAD_HOSTS)) throw invalidLink('shortenTaobaoUrl');
  return url;
}

/** tpwd.create 内层 → {password_simple, model}；任一缺失 / 非字符串 / 空 → upstream_unavailable。 */
export function parseShareCode(inner: unknown): TaobaoShareCode {
  const data = isRecord(inner) ? inner.data : undefined;
  const passwordSimple: unknown = isRecord(data) ? data.password_simple : undefined;
  const model: unknown = isRecord(data) ? data.model : undefined;
  if (
    typeof passwordSimple !== 'string' ||
    passwordSimple === '' ||
    typeof model !== 'string' ||
    model === ''
  ) {
    throw new UnionError(
      'upstream_unavailable',
      `taobao ${TAOBAO_TPWD_CREATE}: share code is missing`,
      'taobao',
    );
  }
  return Object.freeze({ password_simple: passwordSimple, model });
}

function spreadUnavailable(reason: string): UnionError {
  return new UnionError('upstream_unavailable', `taobao ${TAOBAO_SPREAD_GET}: ${reason}`, 'taobao');
}

/**
 * spread.get 内层 → 短链。results 包装（已录 tbk_spread，按单键包装通用解包）下取第一项；
 * results 缺失 / 结构不对 / 空数组 → upstream_unavailable；err_msg 非 OK 或 content 空 →
 * upstream_rejected；content 不以 https://s.click.taobao.com/ 开头 → upstream_unavailable。
 */
export function parseShortLink(inner: unknown): string {
  const results = isRecord(inner) ? inner.results : undefined;
  if (!isRecord(results)) throw spreadUnavailable('results is missing');
  const keys = Object.keys(results);
  if (keys.length !== 1) throw spreadUnavailable('results is not a single wrapper');
  const rows = results[keys[0]!];
  if (!Array.isArray(rows) || rows.length === 0) throw spreadUnavailable('no spread result');
  const first: unknown = rows[0];
  if (!isRecord(first)) throw spreadUnavailable('spread result is not an object');
  const { content, err_msg: errMsg } = first;
  if (errMsg !== 'OK' || content === undefined || content === null || content === '') {
    throw new UnionError(
      'upstream_rejected',
      `taobao ${TAOBAO_SPREAD_GET}: link was not shortened`,
      'taobao',
    );
  }
  if (
    typeof content !== 'string' ||
    !content.startsWith(SHORT_LINK_PREFIX) ||
    content.length > MAX_LINK_LENGTH ||
    hasBlankOrControl(content)
  ) {
    throw spreadUnavailable('short link is not an s.click.taobao.com link');
  }
  return content;
}
