// Admin step-up tokens and the permission guard of admin operations (F1-06l; 08 BR-ID-34
// 「后台 step-up 分两档」, BR-ID-08 「只能用于 1 次成功的业务请求」 as the admin side follows it; 04 §7
// 10003 / 10403; 04 §11; ruling §9.2 #4, #5).
//
// Tokens: an opaque random string (32 random bytes, base64url) handed out by POST
// /admin/v1/auth/step-up. Redis (namespace `admin-step-up`) keeps, under the SHA-256 of the
// token, the account, app and admin session that obtained it, its tier and its expiry by the
// Clock (5 minutes); the Redis TTL only cleans up.
//
// Guard (for the admin operations of every module, through ../index.ts), in this order:
//   1. permission: a super admin has every point; another account needs the point ticked, else
//      10403 data.reason=admin_permission_denied (nothing else is read, no token is used);
//   2. tier = the operation's tier under the point (specs/permissions.yaml), null → run the
//      operation without touching any token, also when one is sent;
//   3. sms tier on an account without a verify phone → 10003 data {tier: sms, reason:
//      verify_phone_missing} (super admins too);
//   4. X-Step-Up-Token missing, unknown, expired, of another account, app or session, of
//      another tier, or in use by a concurrent request → 10003 data {tier} (super admins too);
//   5. the token is claimed (SET NX of a claim key, atomically with its existence check), so
//      concurrent requests with one token run the operation at most once; the operation runs;
//      HTTP 2xx with code 0 consumes the token (the claim stays until the token's expiry);
//      any other answer, or a thrown error, releases the claim: the token stays usable while
//      it is valid.
//
// Pure module apart from Nest's HttpException (no decorators, erasable syntax).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import type { Clock, RedisNamespace } from '../../platform/index.ts';
import { later } from '../domain/login-policy.ts';
import { requiredStepUpTier, type AdminStepUpTier } from '../domain/permission-catalog.ts';
import { STEP_UP_CLEANUP_MARGIN_SEC, STEP_UP_TOKEN_TTL_MS } from '../domain/step-up-policy.ts';

/** Redis namespace shared by the HTTP issuance and every guarded operation. */
export const ADMIN_STEP_UP_NAMESPACE = 'admin-step-up';
/** Request header that carries the step_up_token (never the body). */
export const STEP_UP_TOKEN_HEADER = 'x-step-up-token';

export interface AdminStepUpBinding {
  readonly appId: string;
  readonly adminId: string;
  readonly sessionId: string;
  readonly tier: AdminStepUpTier;
}

export interface AdminStepUpGrant {
  readonly step_up_token: string;
  readonly tier: AdminStepUpTier;
  readonly expire_at: string;
}

export interface AdminStepUpTokens {
  issue(binding: AdminStepUpBinding): Promise<AdminStepUpGrant>;
}

export interface AdminPermissionPrincipal {
  readonly appId: string;
  readonly adminId: string;
  readonly sessionId: string;
  readonly isSuper: boolean;
  readonly permissions: readonly string[];
  readonly hasVerifyPhone: boolean;
}

export interface AdminPermissionRequest {
  /** Trusted server-injected account/session/grants, never request body fields. */
  readonly principal: AdminPermissionPrincipal;
  readonly permission: string;
  readonly operation?: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** trace_id of the error envelopes (the request id); a fresh UUID when absent. */
  readonly traceId?: string;
}

export interface AdminBusinessResponse {
  readonly statusCode: number;
  readonly body: { readonly code: number; readonly data?: unknown };
}

export interface AdminPermissionGuard {
  /** Reject with an HTTP error envelope; consume only after a 2xx/code=0 result. */
  run(
    request: AdminPermissionRequest,
    business: () => Promise<AdminBusinessResponse>,
  ): Promise<AdminBusinessResponse>;
}

/** Fallback texts (clients show their dictionary text error.<code>). */
export const STEP_UP_MESSAGES = Object.freeze({
  10003: '这项操作需要二次验证',
  verify_phone_missing: '这项操作需要短信验证，请先登记验证手机号',
  admin_permission_denied: '当前账号没有这项操作的权限，请联系超级管理员开通',
});

interface TokenRecord {
  readonly appId: string;
  readonly adminId: string;
  readonly sessionId: string;
  readonly tier: AdminStepUpTier;
  readonly expiresAtMs: number;
}

const tokenKey = (digest: string): string => `token:${digest}`;
const claimKey = (digest: string): string => `token-claim:${digest}`;
const digestOf = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Claim a live token: KEYS[1] token, KEYS[2] claim; 1 = claimed by this request. */
const CLAIM_SCRIPT = `if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('SET', KEYS[2], '1', 'NX', 'EX', ARGV[1]) then return 1 end
return 0`;
/** Consume after a successful operation: the token goes, the claim stays until it expires. */
const CONSUME_SCRIPT = `return redis.call('DEL', KEYS[1])`;
/** Release the claim after an operation that did not succeed. */
const RELEASE_SCRIPT = `return redis.call('DEL', KEYS[1])`;

const TIERS: ReadonlySet<unknown> = new Set(['totp', 'sms']);

function parseRecord(value: unknown): TokenRecord | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<TokenRecord>;
    if (
      typeof parsed.appId !== 'string' ||
      typeof parsed.adminId !== 'string' ||
      typeof parsed.sessionId !== 'string' ||
      !TIERS.has(parsed.tier) ||
      typeof parsed.expiresAtMs !== 'number'
    ) {
      return undefined;
    }
    return parsed as TokenRecord;
  } catch {
    return undefined;
  }
}

/** Seconds of Redis lifetime for something that lives until `expiresAtMs` by the Clock. */
function ttlUntil(expiresAtMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1000)) + STEP_UP_CLEANUP_MARGIN_SEC;
}

/** 10003 with data.tier (and data.reason=verify_phone_missing for an sms tier without phone). */
export function stepUpRequired(
  tier: AdminStepUpTier,
  traceId: string,
  verifyPhoneMissing = false,
): HttpException {
  return new HttpException(
    {
      code: 10003,
      msg: verifyPhoneMissing ? STEP_UP_MESSAGES.verify_phone_missing : STEP_UP_MESSAGES[10003],
      data: verifyPhoneMissing ? { tier, reason: 'verify_phone_missing' } : { tier },
      trace_id: traceId,
    },
    403,
  );
}

function permissionDenied(traceId: string): HttpException {
  return new HttpException(
    {
      code: 10403,
      msg: STEP_UP_MESSAGES.admin_permission_denied,
      data: { reason: 'admin_permission_denied' },
      trace_id: traceId,
    },
    403,
  );
}

/** Shared Redis namespace: admin-step-up, used by HTTP issuance and all guarded operations. */
export function createAdminStepUpTokens(deps: {
  readonly clock: Clock;
  readonly redis: RedisNamespace;
}): AdminStepUpTokens {
  const { clock, redis } = deps;
  return {
    async issue({ appId, adminId, sessionId, tier }) {
      const token = randomBytes(32).toString('base64url');
      const now = clock.now();
      const nowMs = now.getTime();
      const expiresAt = later(now, STEP_UP_TOKEN_TTL_MS);
      const expiresAtMs = expiresAt.getTime();
      const record: TokenRecord = { appId, adminId, sessionId, tier, expiresAtMs };
      await redis.set(
        tokenKey(digestOf(token)),
        JSON.stringify(record),
        ttlUntil(expiresAtMs, nowMs),
      );
      return { step_up_token: token, tier, expire_at: expiresAt.toISOString() };
    },
  };
}

function headerToken(headers: AdminPermissionRequest['headers']): string | undefined {
  const value = headers[STEP_UP_TOKEN_HEADER];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const succeeded = (result: AdminBusinessResponse): boolean =>
  result.statusCode >= 200 && result.statusCode <= 299 && result.body.code === 0;

export function createAdminPermissionGuard(deps: {
  readonly clock: Clock;
  readonly redis: RedisNamespace;
}): AdminPermissionGuard {
  const { clock, redis } = deps;

  /** Best effort: a failure leaves the claim in place, which keeps the token unusable. */
  const quietly = async (script: string, key: string): Promise<void> => {
    try {
      await redis.eval(script, { keys: [key], args: [], ttlSeconds: 1 });
    } catch {
      // Fail closed: the claim outlives the token, so a lost write never re-enables it.
    }
  };

  return {
    async run(request, business) {
      const { principal, permission, operation } = request;
      const traceId = request.traceId ?? randomUUID();
      if (!principal.isSuper && !principal.permissions.includes(permission)) {
        throw permissionDenied(traceId);
      }
      const tier = requiredStepUpTier(permission, operation);
      if (tier === null) return await business();
      if (tier === 'sms' && !principal.hasVerifyPhone) throw stepUpRequired(tier, traceId, true);

      const token = headerToken(request.headers);
      if (token === undefined) throw stepUpRequired(tier, traceId);
      const digest = digestOf(token);
      const record = parseRecord(await redis.get(tokenKey(digest)));
      const nowMs = clock.now().getTime();
      if (
        record === undefined ||
        record.expiresAtMs <= nowMs ||
        record.appId !== principal.appId ||
        record.adminId !== principal.adminId ||
        record.sessionId !== principal.sessionId ||
        record.tier !== tier
      ) {
        throw stepUpRequired(tier, traceId);
      }
      const claimed = await redis.eval(CLAIM_SCRIPT, {
        keys: [tokenKey(digest), claimKey(digest)],
        args: [],
        ttlSeconds: ttlUntil(record.expiresAtMs, nowMs),
      });
      if (claimed !== 1) throw stepUpRequired(tier, traceId);

      let result: AdminBusinessResponse;
      try {
        result = await business();
      } catch (error) {
        await quietly(RELEASE_SCRIPT, claimKey(digest));
        throw error;
      }
      if (succeeded(result)) await quietly(CONSUME_SCRIPT, tokenKey(digest));
      else await quietly(RELEASE_SCRIPT, claimKey(digest));
      return result;
    },
  };
}
