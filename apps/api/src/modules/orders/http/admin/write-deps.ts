// B1-10m: what the console's order and claim write controllers share: the Nest token of the use
// case dependencies, the request shape they read and the error envelopes of a refusal. A refusal is
// thrown inside the guard callback, so the guard consumes no step-up token.
import { HttpException } from '@nestjs/common';
import { fieldsErrorEnvelope, type CheckedRequest } from '../../../platform/index.ts';
import type { AdminAssignDeps } from '../../application/admin-assign.ts';
import type { AdminHoldDeps } from '../../application/admin-hold.ts';
import type { ClaimReviewDeps } from '../../application/claim-review.ts';

/** Nest token of the use case dependencies (null in a process without database or event bus). */
export const ADMIN_WRITE_DEPS = Symbol('ORDERS_ADMIN_WRITE_DEPS');

export interface AdminWriteDeps {
  readonly claims: ClaimReviewDeps;
  readonly hold: AdminHoldDeps;
  readonly assign: AdminAssignDeps;
}

export interface AdminWriteRequest extends CheckedRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  readonly ip?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface HeaderReply {
  header(name: string, value: string): unknown;
}

/** HTTP 400, code 20001, data.fields. */
export function fieldsRefusal(fields: readonly string[], traceId: string): HttpException {
  const refused = fieldsErrorEnvelope(fields, traceId);
  return new HttpException(refused.body, refused.statusCode);
}

/** HTTP 409, code 20902, data.resource. */
export function conflictRefusal(resource: string, traceId: string): HttpException {
  return new HttpException(
    { code: 20902, msg: '状态已变化，请刷新后重试', data: { resource }, trace_id: traceId },
    409,
  );
}
