// Per-account voiding instant of the admin console's credentials (B1-34h; 08 BR-ID-43「停用后台
// 账号」「重置身份验证器」「重新生成初始密码」; task §9), kept in Redis (namespace `admin-auth`, key
// `revoked:<app_id>:<admin_id>`). Disable, authenticator reset and initial password regeneration
// record the Clock instant of the change; every admin_token, login ticket and step-up token of the
// account issued before it is void from then on (admin-check, the login steps, the step-up guard).
// row_version is not used: it also moves on writes that void nothing (rename, permission points,
// verify phone). Enabling an account never clears the instant, so what a disable voided stays void.
// B1-34n: enabling an account and binding an authenticator (the first binding after a reset
// included) also record an instant, so a session whose last login step interleaved with a disable
// or a reset (issued in the next whole second, refused meanwhile only for the account's state)
// stays void once the account is usable again. The binding records its ticket's open instant
// rounded down to the whole second, so the admin_token it issues (iat in whole seconds) survives.
//
// The record only ever moves forward (one Lua script keeps the later instant). Its Redis lifetime
// covers the longest credential it can void (the 8-hour admin_token) plus a cleanup margin: once
// it is gone, everything issued before it has expired on its own.
//
// Pure module (no decorators, erasable syntax, type-only imports from the platform barrel).
import type { RedisNamespace } from '../../platform/index.ts';
import { ADMIN_TOKEN_TTL_SEC } from '../domain/login-policy.ts';

export interface AdminRevocations {
  /** Everything of the account issued before `atMs` (epoch ms, by the Clock) is void. */
  voidBefore(account: { appId: string; adminId: string }, atMs: number): Promise<void>;
  /** The account's voiding instant (epoch ms), or null when nothing was voided. */
  voidedAt(account: { appId: string; adminId: string }): Promise<number | null>;
}

const CLEANUP_MARGIN_SEC = 60;
/** Lifetime of the record: the longest-lived credential (admin_token) plus the margin. */
export const ADMIN_REVOCATION_TTL_SEC = ADMIN_TOKEN_TTL_SEC + CLEANUP_MARGIN_SEC;

// Keep the later instant: a delayed write of an older void never moves the instant back.
// ARGV[1] is the TTL (platform redis), ARGV[2] the instant.
const VOID_SCRIPT = `local current = tonumber(redis.call('GET', KEYS[1]))
if current and current >= tonumber(ARGV[2]) then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[1])
return 1`;

const keyOf = (account: { appId: string; adminId: string }): string =>
  `revoked:${account.appId}:${account.adminId}`;

/** True when a credential issued at `issuedAtMs` is void under `voidedAtMs`. */
export function issuedBeforeVoid(issuedAtMs: number, voidedAtMs: number | null): boolean {
  return voidedAtMs !== null && issuedAtMs < voidedAtMs;
}

export function createAdminRevocations(deps: { readonly redis: RedisNamespace }): AdminRevocations {
  const { redis } = deps;
  return {
    async voidBefore(account, atMs) {
      await redis.eval(VOID_SCRIPT, {
        keys: [keyOf(account)],
        args: [String(atMs)],
        ttlSeconds: ADMIN_REVOCATION_TTL_SEC,
      });
    },
    async voidedAt(account) {
      const value = await redis.get(keyOf(account));
      if (value === null) return null;
      const parsed = Number(value);
      // An unreadable record voids everything rather than nothing (fail closed).
      return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
    },
  };
}
