import type { VendorId } from '../vendors/index.ts';
import type { ModelErrorKind, ModelFailure, VendorQuirks } from './types.ts';

export class ModelProtocolError extends Error {
  readonly kind: ModelErrorKind;
  readonly status: number | null;
  readonly vendorCode: string | null;

  /** message 和 detail 只能由本层构造，不得传入上游正文或原始异常。 */
  constructor(
    kind: ModelErrorKind,
    message: string,
    detail?: { status?: number | null; vendorCode?: string | null },
  ) {
    super(message);
    this.name = 'ModelProtocolError';
    this.kind = kind;
    this.status = detail?.status ?? null;
    this.vendorCode = detail?.vendorCode ?? null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function malformed(): ModelProtocolError {
  return new ModelProtocolError('malformed', 'Invalid model protocol payload');
}

export function errorCode(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const code = body.error.code;
  if (typeof code === 'string') return code;
  return typeof code === 'number' && Number.isSafeInteger(code) ? String(code) : null;
}

export function classifyFailure(
  vendor: VendorId,
  failure: ModelFailure,
  quirks: VendorQuirks,
): ModelErrorKind {
  if ('cause' in failure) return failure.cause;
  const code = errorCode(failure.body);
  if (code !== null && quirks.contentRefusalCodes.includes(code)) return 'content_refused';
  if (failure.status === 401 || failure.status === 403) return 'auth';
  if (failure.status === 429) {
    if (vendor === 'glm' && (code === '1113' || code === '1308')) return 'quota_exhausted';
    return 'rate_limited';
  }
  if (failure.status >= 500 && failure.status <= 599) return 'server';
  return 'bad_request';
}
