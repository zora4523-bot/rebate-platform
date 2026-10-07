// Session primitives of identity (规划/08 BR-ID-07 and its 细则「登录时绑定」「退出登录」; 04 §3.2
// sessions / refresh_tokens; migration 0013). Both run inside the caller's transaction.
//
// createSession — every path that creates a session (the login endpoints of B1-02j, a merge that
// issues a new session) calls it in the transaction that creates the session:
//   1. lock the device row (SELECT … FOR UPDATE, scoped by app_id, not revoked: a revoked device
//      gets no new session) before anything else, so two logins on one device serialise and
//      last_login_sid ends at the later one;
//   2. insert the session (UUIDv7 id, a new opaque random sid, created_at / updated_at from the
//      Clock) and its first refresh token (only the SHA-256 of the token; parent_hash null);
//   3. CAS the device row: last_login_sid = the new sid, row_version + 1, guarded by the locked
//      row_version (devices is a CAS entity, 0005);
//   4. call `afterCreated` with the same transaction (the extension point for B1-12b's push token
//      binding), then return the issued pair. The access token carries the caller's scp.
// A refresh (B1-02k, refresh.ts) keeps the sid and does not touch last_login_sid; it reads the
// access expiry the same way (accessExpiry).
//
// revokeSession — fills sessions.revoked_at / revoke_reason once (`revoked_at IS NULL` in the
// WHERE clause; 0 rows = already revoked or unknown, answered false). It writes nothing else:
// refresh tokens are judged through their session (0013 header; orchestrator ruling §9.5 #5), so
// refresh_tokens.rotated_at never stands for a revocation. Used by logout and by B1-02k.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import { randomBytes } from 'node:crypto';
import type { DB } from '@couli/db';
import { decodeJwt } from 'jose';
import type { Transaction } from 'kysely';
import { newUuidV7, type Clock, type TokenPrincipal } from '../../platform/index.ts';
import type { TokenService } from './access-tokens.ts';

export interface IssuedSession {
  readonly sid: string;
  readonly access_token: string;
  readonly refresh_token: string;
  readonly session_scope: TokenPrincipal['scp'];
  /** The `exp` of the issued access token (whole seconds), read back from the token itself. */
  readonly access_expires_at: Date;
  /** The expiry stored in refresh_tokens.expire_at for this refresh token. */
  readonly refresh_expires_at: Date;
}

/** An opaque session id: 128 random bits, base64url (04 §3.2 keeps sid opaque text). */
function newSid(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * The instant of the access token's own `exp` claim (the token was just signed here, so it is
 * decoded, not verified), so an answer never drifts from the JWT when the Clock crosses a second
 * between reads. Built from `like` (a Clock instant), never from the wall clock.
 */
export function accessExpiry(token: string, like: Date): Date {
  const { exp } = decodeJwt(token);
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp)) {
    throw new Error('identity: the issued access token has no exp');
  }
  const result = structuredClone(like);
  result.setTime(exp * 1000);
  return result;
}

/** Caller owns the transaction. Lock device first, insert session and hashed refresh, CAS device.
 * afterCreated is the same-transaction extension point for B1-12b, after last_login_sid is set.
 */
export async function createSession(
  transaction: Transaction<DB>,
  principal: Omit<TokenPrincipal, 'sid'>,
  deps: { clock: Clock; tokens: TokenService },
  afterCreated?: (transaction: Transaction<DB>, session: IssuedSession) => Promise<void>,
): Promise<IssuedSession> {
  const { clock, tokens } = deps;
  const now = clock.now();
  const device = await transaction
    .selectFrom('devices')
    .select('row_version')
    .where('app_id', '=', principal.app_id)
    .where('id', '=', principal.device_id)
    .where('revoked_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (device === undefined) {
    throw new Error('identity: a session needs an unrevoked device of the same app');
  }
  const sid = newSid();
  await transaction
    .insertInto('sessions')
    .values({
      id: newUuidV7(now),
      app_id: principal.app_id,
      sid,
      user_id: principal.uid,
      device_id: principal.device_id,
      revoked_at: null,
      revoke_reason: null,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const refresh = tokens.issueRefresh();
  await transaction
    .insertInto('refresh_tokens')
    .values({
      id: newUuidV7(now),
      app_id: principal.app_id,
      sid,
      token_hash: refresh.hash,
      parent_hash: null,
      rotated_at: null,
      expire_at: refresh.expireAt,
      created_at: now,
      updated_at: now,
    })
    .execute();
  const bound = await transaction
    .updateTable('devices')
    .set({ last_login_sid: sid, row_version: device.row_version + 1, updated_at: now })
    .where('app_id', '=', principal.app_id)
    .where('id', '=', principal.device_id)
    .where('row_version', '=', device.row_version)
    .executeTakeFirst();
  if (bound.numUpdatedRows !== 1n) {
    throw new Error('identity: the locked device row changed before last_login_sid was written');
  }
  const accessToken = await tokens.issueAccess({ ...principal, sid });
  const session: IssuedSession = Object.freeze({
    sid,
    access_token: accessToken,
    refresh_token: refresh.token,
    session_scope: principal.scp,
    access_expires_at: accessExpiry(accessToken, now),
    refresh_expires_at: refresh.expireAt,
  });
  if (afterCreated !== undefined) await afterCreated(transaction, session);
  return session;
}

/** Fill sessions.revoked_at/revoke_reason once; never mark refresh_tokens.rotated_at. */
export async function revokeSession(
  transaction: Transaction<DB>,
  input: { app_id: string; sid: string; reason: string },
  clock: Clock,
): Promise<boolean> {
  if (typeof input.reason !== 'string' || input.reason === '') {
    throw new TypeError('revokeSession needs a reason');
  }
  const now = clock.now();
  const result = await transaction
    .updateTable('sessions')
    .set({ revoked_at: now, revoke_reason: input.reason, updated_at: now })
    .where('app_id', '=', input.app_id)
    .where('sid', '=', input.sid)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}
