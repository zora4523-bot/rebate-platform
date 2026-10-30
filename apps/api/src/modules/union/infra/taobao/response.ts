// 淘宝（TOP）网关响应外层解包与 error_response 分类（B1-04j）。
// 外层键由调用方按接口显式给出（② 段每个接口用常量登记），不由方法名推导。
// HTTP 5xx → upstream_unavailable；body 非 JSON / 非对象 → upstream_unavailable；
// 顶层有 error_response 先判错误：code 7 或 sub_code 以 isp.call-limited 开头 → rate_limited；
// code 11 → upstream_rejected 并告警一次；code 15 → upstream_rejected；其他 code → upstream_rejected。
// 数字 code 与同值字符串同等处理。否则必须有该外层键（自有属性）且值为对象，返回其内层对象；
// 缺键 / 非对象 → upstream_unavailable。错误信息只带方法名与 code / sub_code，
// 不带 msg、sub_msg、request_id 与请求内容；这里只取外层，不做任何字段映射。
import { UnionError, type UnionErrorCode } from '../../domain/types.ts';
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

/** 无 API 权限（权限包未开通等）：分类之外另发一条只含方法名与 code / sub_code 的告警。 */
const PERMISSION_CODE = '11';
const RATE_LIMIT_CODE = '7';
const RATE_LIMIT_SUB_CODE_PREFIX = 'isp.call-limited';

/** Codes echoed into messages and warnings: short and plain, never free upstream text. */
const CODE_TEXT = /^[A-Za-z0-9._:-]{1,64}$/;

/** The code as text when it is a short plain scalar; anything else is treated as absent. */
function codeText(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (CODE_TEXT.test(trimmed)) return trimmed;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unavailable(method: string, reason: string): UnionError {
  return new UnionError('upstream_unavailable', `taobao ${method}: ${reason}`, 'taobao');
}

function classify(code: string | undefined, subCode: string | undefined): UnionErrorCode {
  if (code === RATE_LIMIT_CODE || subCode?.startsWith(RATE_LIMIT_SUB_CODE_PREFIX) === true) {
    return 'rate_limited';
  }
  // code 11（无权限）、15（业务错，按 sub_code 细分留给 ② 段）与表外 code 都是上游拒绝。
  return 'upstream_rejected';
}

function failure(
  method: string,
  error: unknown,
  warn: ((event: TaobaoWarning) => void) | undefined,
): UnionError {
  const fields = isRecord(error) ? error : {};
  const code = codeText(fields.code);
  const subCode = codeText(fields.sub_code);
  if (code === PERMISSION_CODE) {
    warn?.(subCode === undefined ? { method, code } : { method, code, sub_code: subCode });
  }
  const detail = `code=${code ?? 'unknown'}${subCode === undefined ? '' : ` sub_code=${subCode}`}`;
  return new UnionError(classify(code, subCode), `taobao ${method}: ${detail}`, 'taobao');
}

/** Internal gateway envelope decoder, not a product / order / link DTO mapper. */
export function unwrapTaobaoResponse(
  method: string,
  envelope: string,
  response: UnionTransportResponse,
  warn?: (event: TaobaoWarning) => void,
): unknown {
  if (response.status >= 500) throw unavailable(method, `HTTP ${response.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw unavailable(method, 'response is not JSON');
  }
  if (!isRecord(parsed)) throw unavailable(method, 'unexpected response');
  if (Object.hasOwn(parsed, 'error_response')) throw failure(method, parsed.error_response, warn);
  if (!Object.hasOwn(parsed, envelope)) throw unavailable(method, 'missing response envelope');
  const inner = parsed[envelope];
  if (!isRecord(inner)) throw unavailable(method, 'response envelope is not an object');
  return inner;
}
