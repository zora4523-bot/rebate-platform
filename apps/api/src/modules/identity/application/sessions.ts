import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock, TokenPrincipal } from '../../platform/index.ts';
import type { TokenService } from './access-tokens.ts';

export interface IssuedSession {
  readonly sid: string;
  readonly access_token: string;
  readonly refresh_token: string;
  readonly session_scope: TokenPrincipal['scp'];
}

/** Caller owns the transaction. Lock device first, insert session and hashed refresh, CAS device.
 * afterCreated is the same-transaction extension point for B1-12b, after last_login_sid is set.
 */
export function createSession(
  transaction: Transaction<DB>,
  principal: Omit<TokenPrincipal, 'sid'>,
  deps: { clock: Clock; tokens: TokenService },
  afterCreated?: (transaction: Transaction<DB>, session: IssuedSession) => Promise<void>,
): Promise<IssuedSession> {
  void transaction;
  void principal;
  void deps;
  void afterCreated;
  throw new Error('NotImplemented: createSession');
}

/** Fill sessions.revoked_at/revoke_reason once; never mark refresh_tokens.rotated_at. */
export function revokeSession(
  transaction: Transaction<DB>,
  input: { app_id: string; sid: string; reason: string },
  clock: Clock,
): Promise<boolean> {
  void transaction;
  void input;
  void clock;
  throw new Error('NotImplemented: revokeSession');
}
