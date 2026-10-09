// admin_token (F1-06k; 08 BR-ID-34; 02 §12.1: JWT, its own signing key, aud=admin, 8 hours):
// HS256 with ADMIN_TOKEN_SIGNING_KEY (jose; algorithm pinned, so an ES256 token signed with the
// app key, an unsigned token or a token for another audience never verifies). Claims: sub =
// admin_users.id, app_id, aud=admin, iss, jti (the session id), iat, exp = iat + 8 h. Time comes
// from the injected Clock only. The idle timeout and the revocation live in the session store.
//
// Pure module (no decorators, erasable syntax, type-only imports from the platform barrel).
import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, errors, jwtVerify } from 'jose';
import type { Clock } from '../../platform/index.ts';
import {
  ADMIN_TOKEN_AUDIENCE,
  ADMIN_TOKEN_ISSUER,
  ADMIN_TOKEN_TTL_SEC,
} from '../domain/login-policy.ts';

export interface AdminTokenClaims {
  readonly adminId: string;
  readonly appId: string;
  readonly sessionId: string;
  /** Epoch seconds. */
  readonly issuedAt: number;
  /** Epoch seconds. */
  readonly expiresAt: number;
}

export interface AdminTokens {
  issue(input: { adminId: string; appId: string }): Promise<{
    readonly token: string;
    readonly claims: AdminTokenClaims;
  }>;
  /** The verified claims, or null for any token that is not a valid, unexpired admin_token. */
  verify(token: string): Promise<AdminTokenClaims | null>;
}

/** The configured key, or (local / test without one) a random key for this process. */
export function adminTokenKey(configured: Uint8Array | null): Uint8Array {
  return configured ?? new Uint8Array(randomBytes(32));
}

const isClaim = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export function createAdminTokens(deps: {
  readonly key: Uint8Array;
  readonly clock: Clock;
}): AdminTokens {
  const { key, clock } = deps;
  return {
    async issue({ adminId, appId }) {
      const issuedAt = Math.floor(clock.now().getTime() / 1000);
      const claims: AdminTokenClaims = {
        adminId,
        appId,
        sessionId: randomUUID(),
        issuedAt,
        expiresAt: issuedAt + ADMIN_TOKEN_TTL_SEC,
      };
      const token = await new SignJWT({ app_id: appId })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(ADMIN_TOKEN_ISSUER)
        .setAudience(ADMIN_TOKEN_AUDIENCE)
        .setSubject(adminId)
        .setJti(claims.sessionId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(claims.expiresAt)
        .sign(key);
      return { token, claims };
    },

    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: ['HS256'],
          issuer: ADMIN_TOKEN_ISSUER,
          audience: ADMIN_TOKEN_AUDIENCE,
          typ: 'JWT',
          requiredClaims: ['sub', 'jti', 'iat', 'exp'],
          maxTokenAge: ADMIN_TOKEN_TTL_SEC,
          clockTolerance: 0,
          currentDate: clock.now(),
        });
        const { sub, jti, app_id: appId, iat, exp } = payload;
        if (!isClaim(sub) || !isClaim(jti) || !isClaim(appId)) return null;
        if (typeof iat !== 'number' || typeof exp !== 'number') return null;
        return { adminId: sub, appId, sessionId: jti, issuedAt: iat, expiresAt: exp };
      } catch (error) {
        if (error instanceof errors.JOSEError || error instanceof TypeError) return null;
        throw error;
      }
    },
  };
}
