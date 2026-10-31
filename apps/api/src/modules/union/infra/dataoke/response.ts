// 大淘客网关响应外层解包与错误分类（B1-04m，D10-486 ①）。
// HTTP 5xx → upstream_unavailable；body 非 JSON / 非对象 / 缺 code → upstream_unavailable。
// 外层 code 非 0（数字与同值字符串同等）按 gz-13 分类：限流码 → rate_limited；签名 / 凭据 / 授权码 →
// upstream_rejected 并调 warn 一次（只带路径与 code）；服务端暂时故障码 → upstream_unavailable；
// 其余 → upstream_rejected。外层 code 0：data 必须是对象，否则 upstream_unavailable；data 里有淘宝
// TOP 形式的 error_response 时按 B1-04j 同义分类（code 7 或 sub_code 以 isp.call-limited 开头 →
// rate_limited；code 11 → upstream_rejected 并 warn；其余 → upstream_rejected）；否则返回 data。
// 错误信息只带路径与 code（及 sub_code），不带 msg / sub_msg / request_id / 参数；不做字段映射。
// TODO(规划/11 §4.5): 外层键名、成功码与错误码待大淘客实测录制核对 — blocked on 大淘客录制
import type { UnionTransportResponse } from '../replay.ts';

/**
 * Sent once for a signature / credential / authorisation outer code, or for a TOP code 11 inside
 * data. Carries only the request path and the code (string form) plus the TOP sub_code; never msg,
 * sub_msg, request_id, parameters or credentials.
 */
export interface DataokeWarning {
  readonly path: string;
  readonly code: string;
  readonly sub_code?: string;
}

/** Internal gateway envelope decoder: returns the `data` object, maps no fields. */
export function unwrapDataokeResponse(
  path: string,
  response: UnionTransportResponse,
  warn?: (event: DataokeWarning) => void,
): Readonly<Record<string, unknown>> {
  void path;
  void response;
  void warn;
  throw new Error('NotImplemented: unwrapDataokeResponse');
}
