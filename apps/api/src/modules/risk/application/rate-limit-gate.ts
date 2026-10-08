// HTTP placement of stage ⑬ (规划/08 BR-ID-01 判定顺序: ⑬ after ④a; task B1-03e §9.2, §10), on the
// same two paths as stage ④a (./minimum-version.ts):
// - non-idempotent operations: the global guard, after ④a (RiskModule chains both in one guard,
//   so a request ④a refuses never reaches the buckets), after the pre-parsing checks ① ② ③ (a
//   request they refuse never reaches a guard, so it spends no token);
// - idempotent operations: the idempotency post-miss hook, registered after ④a's, so a replay,
//   40901 and the other idempotency refusals spend nothing and a 42901 writes no idempotency
//   record. The hook reads the HTTP request and its reply from MINIMUM_VERSION_SCOPE.
// The operation is the contract operation of the matched route (operationId); a route outside the
// contract is not limited. Identities are only the verified ones: the token principal (stage ②),
// else the device stage ① verified, and Fastify's request.ip, as identity's SMS routes use it; a
// bare X-Device-Id header is never read. The app is the principal's, else the verified device's,
// else X-App-Id (route schema validated; an unsigned anonymous request has nothing else).
// A refusal is the contract TooManyRequests response: HTTP 429, { code: 42901, msg, trace_id } and
// a Retry-After header in whole seconds. No risk_hits row (a rate limit is not a blocklist hit).
import { HttpException } from '@nestjs/common';
import {
  idempotencyPostMissTransaction,
  tokenPrincipal,
  type CheckedRequest,
  type IdempotencyPostMissCheck,
} from '../../platform/index.ts';
import {
  MINIMUM_VERSION_SCOPE,
  contractRouteOf,
  type MinimumVersionRequest,
} from './minimum-version.ts';
import type {
  RateLimitRequest,
  RateLimitService,
  RateLimitThresholdReader,
  RateLimitThresholdReaderOn,
} from './rate-limit.ts';

/** The parsed Fastify request as stage ⑬ reads it. */
export interface RateLimitHttpRequest extends MinimumVersionRequest {
  readonly ip?: string;
}

/** The Fastify reply: stage ⑬ sets Retry-After on it. */
export interface RateLimitReply {
  header(name: string, value: string): unknown;
}

/** The meaning of 42901 in contracts/error-codes.yaml. */
const TOO_MANY_REQUESTS_MSG = '请求过于频繁';

function header(request: MinimumVersionRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The stage ⑬ input of an HTTP request; undefined when the route is outside the contract. */
export function rateLimitRequestOf(request: RateLimitHttpRequest): RateLimitRequest | undefined {
  const route = contractRouteOf(request);
  if (route === undefined) return undefined;
  const principal = tokenPrincipal(request);
  const verifiedDevice = (request as CheckedRequest).verifiedDevice;
  const appId = principal?.app_id ?? verifiedDevice?.appId ?? header(request, 'x-app-id');
  if (appId === undefined) return undefined;
  return {
    entry: 'api',
    operationId: route.operationId,
    app_id: appId,
    ...(principal === undefined ? {} : { principal }),
    ...(verifiedDevice === undefined ? {} : { verifiedDevice }),
    ...(typeof request.ip === 'string' && request.ip !== '' ? { client_ip: request.ip } : {}),
  };
}

/** The 429 / 42901 refusal; Retry-After is set on the reply before it is thrown. */
export class RateLimitedException extends HttpException {
  readonly retryAfterSec: number;

  constructor(traceId: string, retryAfterSec: number) {
    super({ code: 42901, msg: TOO_MANY_REQUESTS_MSG, trace_id: traceId }, 429);
    this.name = 'RateLimitedException';
    this.retryAfterSec = retryAfterSec;
  }
}

/** Judges one HTTP request; throws RateLimitedException (after setting Retry-After) on 42901. */
export async function judgeRateLimit(
  service: RateLimitService,
  request: RateLimitHttpRequest,
  reply: RateLimitReply | undefined,
  thresholds?: RateLimitThresholdReader,
): Promise<void> {
  const input = rateLimitRequestOf(request);
  if (input === undefined) return;
  const result = await service.check(input, thresholds);
  if (result.code === 0) return;
  reply?.header('Retry-After', String(result.retryAfterSec));
  throw new RateLimitedException(request.id, result.retryAfterSec);
}

export interface RateLimitGuardContext {
  switchToHttp(): {
    getRequest(): RateLimitHttpRequest;
    getResponse(): RateLimitReply;
  };
}

/** The guard part of stage ⑬: non-idempotent contract operations (idempotent ones: the hook). */
export function createRateLimitGuard(service: RateLimitService) {
  return {
    async canActivate(context: RateLimitGuardContext): Promise<boolean> {
      const http = context.switchToHttp();
      const request = http.getRequest();
      if (contractRouteOf(request)?.idempotent === true) return true;
      await judgeRateLimit(service, request, http.getResponse());
      return true;
    },
  };
}

/**
 * The post-miss hook part of stage ⑬: the HTTP request in MINIMUM_VERSION_SCOPE (nothing to judge
 * outside one, e.g. a job). The hook runs inside the idempotency claim's transaction, which holds
 * a pooled connection: it must not borrow a second one (a pool full of claims would wait on
 * itself, the pool having no acquire timeout), so the thresholds are read by a reader built on
 * that transaction (idempotencyPostMissTransaction(), the RateLimitThresholdReaderOn factory:
 * uncached, read on the claim's connection). Without a factory (no database on the entry) the
 * service's own reader serves, which then reads no database (code defaults).
 */
export function createRateLimitPostMissCheck(
  service: RateLimitService,
  thresholdsOn?: RateLimitThresholdReaderOn,
): IdempotencyPostMissCheck {
  return async () => {
    const scope = MINIMUM_VERSION_SCOPE.getStore();
    if (scope === undefined) return;
    const trx = idempotencyPostMissTransaction();
    await judgeRateLimit(
      service,
      scope.request as RateLimitHttpRequest,
      scope.reply,
      thresholdsOn === undefined || trx === undefined ? undefined : thresholdsOn(trx),
    );
  };
}
