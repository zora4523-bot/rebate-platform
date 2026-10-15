// 拼多多网关响应外层解包与 error_response 分类（4_PDD_附 §3.4）。外层键不能由接口名推导，
// 只认下表逐个登记的接口；商品接口的外层键按 probe 实测登记（B1-04u）。这里只取外层，
// 不做任何商品 / 订单 / 转链字段映射。错误信息只带接口名与 error_code / sub_code。
import { UnionError, type UnionErrorCode } from '../../domain/types.ts';
import type { UnionTransportResponse } from '../replay.ts';

/**
 * Deliberately contains neither credentials nor upstream message/request contents.
 * B1-04u：商品价格异常（BR-PRICE-01）也走这个钩子，error_code 为 'PRICE_ANOMALY'、event 同值、
 * type 为接口名，不带商品信息。
 */
export interface PddWarning {
  readonly error_code: string;
  readonly type: string;
  readonly event?: 'PRICE_ANOMALY';
}

/** 接口名 → 响应外层键；4_PDD_附 §3.4 列出的接口，加 B1-04u probe 实测的商品接口。 */
const ENVELOPES: ReadonlyMap<string, string> = new Map([
  ['pdd.ddk.order.list.increment.get', 'order_list_get_response'],
  ['pdd.ddk.order.list.range.get', 'order_list_get_response'],
  ['pdd.ddk.order.detail.get', 'order_detail_response'],
  ['pdd.ddk.member.authority.query', 'authority_query_response'],
  ['pdd.ddk.goods.zs.unit.url.gen', 'goods_zs_unit_generate_response'],
  ['pdd.ddk.rp.prom.url.generate', 'rp_promotion_url_generate_response'],
  ['pdd.ddk.goods.pid.generate', 'p_id_generate_response'],
  ['pdd.ddk.pid.mediaid.bind', 'p_id_bind_response'],
  // B1-04u：probe 实测外层键（approvals 28/29，cap-tests/2026-10-15/pdd/）。
  ['pdd.ddk.goods.search', 'goods_search_response'],
  ['pdd.ddk.goods.detail', 'goods_detail_response'],
  ['pdd.ddk.goods.recommend.get', 'goods_basic_detail_response'],
  ['pdd.ddk.url.short.parse', 'url'],
]);

const CLASSIFICATION: ReadonlyMap<string, UnionErrorCode> = new Map<string, UnionErrorCode>([
  ['20004', 'upstream_rejected'],
  ['20005', 'upstream_rejected'],
  ['20031', 'upstream_rejected'],
  ['10019', 'upstream_rejected'],
  ['70032', 'upstream_rejected'],
  ['70034', 'upstream_rejected'],
  ['70035', 'upstream_rejected'],
  ['70036', 'upstream_rejected'],
  ['52101', 'rate_limited'],
  ['70031', 'rate_limited'],
  ['52102', 'upstream_unavailable'],
  ['52103', 'upstream_unavailable'],
  ['70033', 'upstream_unavailable'],
  ['50000', 'upstream_unavailable'],
  ['50001', 'upstream_unavailable'],
  ['50002', 'upstream_unavailable'],
  ['52001', 'upstream_unavailable'],
  ['52002', 'upstream_unavailable'],
]);

/** 签名失败、IP 未登记、应用风险：除分类外另发一条只含 error_code 与接口名的告警事件。 */
const WARN_CODES: ReadonlySet<string> = new Set(['20004', '20005', '70035']);

const MAX_CODE_LENGTH = 64;

/** The envelope key registered for `method`, or undefined when the method is not registered. */
export function pddEnvelopeKey(method: string): string | undefined {
  return ENVELOPES.get(method);
}

function unregistered(method: string): UnionError {
  return new UnionError('adapter_unimplemented', `pdd ${method}: not implemented`, 'pdd');
}

/** Only short scalar codes are echoed into messages; anything else becomes `unknown`. */
function codeText(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.length > 0 && value.length <= MAX_CODE_LENGTH) {
    return value.trim();
  }
  return 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Internal gateway envelope decoder, not a product/order DTO mapper. */
export function unwrapPddResponse(
  method: string,
  response: UnionTransportResponse,
  warn?: (event: PddWarning) => void,
): unknown {
  const key = pddEnvelopeKey(method);
  if (key === undefined) throw unregistered(method);
  if (response.status >= 500) {
    throw new UnionError('upstream_unavailable', `pdd ${method}: HTTP ${response.status}`, 'pdd');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new UnionError('upstream_unavailable', `pdd ${method}: response is not JSON`, 'pdd');
  }
  if (!isRecord(parsed)) {
    throw new UnionError('upstream_unavailable', `pdd ${method}: unexpected response`, 'pdd');
  }
  if (Object.hasOwn(parsed, 'error_response')) {
    const failure = isRecord(parsed.error_response) ? parsed.error_response : {};
    const errorCode = codeText(failure.error_code);
    const subCode = codeText(failure.sub_code);
    const code = CLASSIFICATION.get(errorCode) ?? 'upstream_rejected';
    if (WARN_CODES.has(errorCode)) warn?.({ error_code: errorCode, type: method });
    throw new UnionError(code, `pdd ${method}: error_code=${errorCode} sub_code=${subCode}`, 'pdd');
  }
  if (!Object.hasOwn(parsed, key)) {
    throw new UnionError(
      'upstream_unavailable',
      `pdd ${method}: missing ${key} in response`,
      'pdd',
    );
  }
  return parsed[key];
}
