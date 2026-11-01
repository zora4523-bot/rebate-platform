// B2-15k: what both real channel adapters share: the fixed vocabulary of an unknown result, the
// response field checks and the channel's time formats. Ported from task/PAY-01 packages/pay-channels;
// code review r3 must-fix ⑤: only known constants reach a reason or a log line, any other code is a
// fixed placeholder and an exception maps to a fixed category. No allow list here decides anything:
// a code that is listed only gets printed, every channel error stays unknown (r3 ①).
// Also compiled by the `test` project: erasable syntax only.
import { parseFen } from '@couli/money';
import { PayResponseTooLarge } from './transport.ts';

export type Json = Readonly<Record<string, unknown>>;

/** The error codes written in the channels' documents (specs/*-pay-error-map.csv); printable only. */
const PRINTABLE_CODES: ReadonlySet<string> = new Set([
  // WeChat Pay: docs-mirror/wechat-pay/pages/4013070347, 4013070356, 4013070360, 4013070371,
  // 4013070374, 4013071227 (error code tables).
  'APPID_MCHID_NOT_MATCH',
  'FREQUENCY_LIMITED',
  'INVALID_REQUEST',
  'MCH_NOT_EXISTS',
  'NO_AUTH',
  'NO_STATEMENT_EXIST',
  'NOT_ENOUGH',
  'ORDER_NOT_EXIST',
  'OUT_TRADE_NO_USED',
  'PARAM_ERROR',
  'RESOURCE_NOT_EXISTS',
  'RULE_LIMIT',
  'SIGN_ERROR',
  'STATEMENT_CREATING',
  'SYSTEM_ERROR',
  'TRADE_ERROR',
  // Alipay: docs-mirror/alipay/guides/common-02km9f.md (main codes), app-pay/02e7gm.md, 02e7gn.md,
  // 02e7go.md, 02e7gp.md, 02e7gr.md (the codes this adapter's calls most often meet).
  '20000',
  '20001',
  '40001',
  '40002',
  '40003',
  '40004',
  '40005',
  '40006',
  'aop.unknow-error',
  'isp.unknow-error',
  'isv.insufficient-isv-permissions',
  'isv.invalid-signature',
  'ACQ.INVALID_PARAMETER',
  'ACQ.REASON_ILLEGAL_STATUS',
  'ACQ.REASON_TRADE_STATUS_INVALID',
  'ACQ.SELLER_BALANCE_NOT_ENOUGH',
  'ACQ.SYSTEM_ERROR',
  'ACQ.TRADE_HAS_CLOSE',
  'ACQ.TRADE_HAS_FINISHED',
  'ACQ.TRADE_NOT_ALLOW_REFUND',
  'ACQ.TRADE_NOT_EXIST',
  'ACQ.TRADE_STATUS_ERROR',
  'BILL_NOT_EXIST',
  'NO_BILL_DATA',
  'TRADE_NOT_EXIST',
  'TYPE_NOT_SUPPORTED',
]);

/** Whether a code from a channel answer may be printed. */
export function isPrintableCode(code: unknown): code is string {
  return typeof code === 'string' && PRINTABLE_CODES.has(code);
}

/** The reason of a verified channel error: the code when it is a known constant, else a placeholder. */
export function channelErrorReason(...codes: readonly unknown[]): string {
  const known = codes.find(isPrintableCode);
  return `channel_error:${known ?? 'other'}`;
}

/** r3 建议改 ③: a diagnostic code from an answer whose signature did not verify; never a result. */
export function unverifiedErrorReason(code: unknown, fallback: string): string {
  return isPrintableCode(code) ? `unverified_error:${code}` : fallback;
}

/** An exception of a transport, as a fixed category: its name and message never leave here. */
export function transportFailureReason(error: unknown): string {
  if (error instanceof PayResponseTooLarge) return 'response_too_large';
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  return 'transport_error';
}

/** A JSON object, or null for anything else (invalid JSON, null, an array, a scalar). */
export function parseJsonObject(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

export function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/**
 * r3 must-fix ②③: a field the answer does carry must be the value of this very request, on error
 * answers as well: a valid signature proves who answered, not which request was answered.
 */
export function echoConflicts(
  answer: Json,
  expected: Readonly<Record<string, string | null | undefined>>,
): boolean {
  for (const [field, value] of Object.entries(expected)) {
    if (value !== null && value !== undefined && field in answer && answer[field] !== value) {
      return true;
    }
  }
  return false;
}

/** A positive integer of fen as a JSON number (WeChat Pay), or null; through @couli/money only. */
export function fenFromJson(value: unknown): bigint | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return parseFen(value);
}

/** The instant in +08:00 as `yyyy-MM-ddTHH:mm:ss`, milliseconds dropped (never rounded up). */
function chinaIso(at: Date): string {
  // A copy moved by the offset: no `new Date(` in app code, the given instant is never modified.
  const moved = structuredClone(at);
  moved.setTime(at.getTime() + 8 * 3_600_000);
  return moved.toISOString().slice(0, 19);
}

/** RFC 3339 in +08:00 (docs-mirror/wechat-pay/pages/4013070347.txt time_expire). */
export function rfc3339China(at: Date): string {
  return `${chinaIso(at)}+08:00`;
}

/** `yyyy-MM-dd HH:mm:ss` in +08:00 (docs-mirror/alipay/app-pay/02e7gq.md timestamp). */
export function alipayDateTime(at: Date): string {
  return chinaIso(at).replace('T', ' ');
}

/** The full notification address of a route on PAY_NOTIFY_BASE_URL, or null. */
export function notifyAddress(path: string, base: string): string | null {
  try {
    return new URL(path, base).toString();
  } catch {
    return null;
  }
}

export const BILL_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Bills have no documented size; a larger file is a failed download, not a truncated one. */
export const BILL_MAX_BYTES = 64 * 1024 * 1024;
export const API_TIMEOUT_MS = 10_000;
export const BILL_TIMEOUT_MS = 60_000;
