// 淘宝（TOP）网关响应外层解包与 error_response 分类（B1-04j，骨架；实现见实现轮）。
// 外层键由调用方按接口显式给出（② 段每个接口用常量登记），不由方法名推导。
// HTTP 5xx → upstream_unavailable；body 非 JSON / 非对象 → upstream_unavailable；
// 顶层有 error_response 先判错误：code 11 → upstream_rejected 并告警一次；code 15 → upstream_rejected；
// code 7 或 sub_code 以 isp.call-limited 开头 → rate_limited；其他 code → upstream_rejected。
// 数字 code 与同值字符串同等处理。否则必须有该外层键（自有属性）且值为对象，返回其内层对象；
// 缺键 / 非对象 → upstream_unavailable。错误信息只带方法名与 code / sub_code。
import type { UnionTransportResponse } from '../replay.ts';

/**
 * The warning sent once for code 11 (no API permission). Carries no msg, sub_msg, request_id or
 * credential; `code` is the string form whether the wire had a number or a string.
 */
export interface TaobaoWarning {
  readonly method: string;
  readonly code: string;
  readonly sub_code?: string;
}

/** Internal gateway envelope decoder, not a product / order / link DTO mapper. */
export function unwrapTaobaoResponse(
  method: string,
  envelope: string,
  response: UnionTransportResponse,
  warn?: (event: TaobaoWarning) => void,
): unknown {
  void method;
  void envelope;
  void response;
  void warn;
  throw new Error('NotImplemented: unwrapTaobaoResponse');
}
