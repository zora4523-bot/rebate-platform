// h5_token (规划/08 BR-ID-32, 细则「只读作用域」「h5_token 随会话失效」; 04 §6.1 POST
// /v1/auth/h5-token; orchestrator ruling B1-02f §9.2). The native app exchanges its session for a
// token its trusted H5 pages use instead of the access token.
//
// The session (sid) of the caller's access token must still be live (10002 otherwise: a revoked
// session cannot issue, BR-ID-07). scope is what the native app sent, read_only when absent.
// ES256 with the access token's key and issuer, aud=h5, claims uid, app_id, sid (the issuing
// session: revoking it voids the h5_token at the token check), device_id, scp, iat, exp = iat +
// auth.h5_token_ttl_sec (default 900). Where an h5_token is accepted and what it may call is the
// token check's part (access-tokens.ts createTokenCheck). Nothing is logged.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import type { Schema } from '@couli/contracts-ts';
import type { Clock, TokenPrincipal } from '../../platform/index.ts';
import {
  H5_AUDIENCE,
  signScopedToken,
  type SessionLookup,
  type TokenKeyProvider,
} from './access-tokens.ts';
import { configuredSeconds, instantPlus } from './config-seconds.ts';
import type { SmsConfigReader } from './sms-codes.ts';

export interface H5TokenService {
  issue(command: {
    readonly principal: TokenPrincipal;
    readonly body: Schema<'IssueH5TokenRequest'>;
  }): Promise<
    { readonly code: 0; readonly data: Schema<'H5TokenData'> } | { readonly code: 10002 | 50001 }
  >;
}

export interface H5TokenOptions {
  readonly clock: Clock;
  readonly keys: TokenKeyProvider;
  readonly sessions: SessionLookup;
  readonly config: SmsConfigReader;
}

/** Configuration key of the h5_token lifetime (BR-ID-32). */
export const H5_TTL_KEY = 'auth.h5_token_ttl_sec';
/** BR-ID-32: an h5_token is valid for 15 minutes unless the app configures otherwise. */
export const H5_TTL_DEFAULT = 900;
/** BR-ID-32 细则「只读作用域」: a request without a scope gets a read-only token. */
export const H5_TOKEN_DEFAULT_SCOPE = 'read_only';

export function createH5TokenService(options: H5TokenOptions): H5TokenService {
  const { clock, keys, sessions, config } = options;
  return Object.freeze({
    async issue(command: Parameters<H5TokenService['issue']>[0]) {
      const { principal, body } = command;
      const session = await sessions.find(principal.app_id, principal.sid);
      if (session === null || session.revoked_at !== null) return { code: 10002 as const };
      const scope = body.scope ?? H5_TOKEN_DEFAULT_SCOPE;
      const ttlSeconds = await configuredSeconds(
        config,
        principal.app_id,
        H5_TTL_KEY,
        H5_TTL_DEFAULT,
      );
      const now = clock.now();
      const issuedAt = Math.floor(now.getTime() / 1000);
      const token = await signScopedToken(keys, {
        audience: H5_AUDIENCE,
        claims: {
          uid: principal.uid,
          app_id: principal.app_id,
          sid: principal.sid,
          device_id: principal.device_id,
          scp: scope,
        },
        issuedAt,
        ttlSeconds,
      });
      const expireAt = instantPlus(now, (issuedAt + ttlSeconds) * 1000 - now.getTime());
      return { code: 0 as const, data: { token, expire_at: expireAt.toISOString(), scope } };
    },
  });
}
