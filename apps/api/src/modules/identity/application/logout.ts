// Contract operation `logout` (POST /v1/auth/logout; 04 §6.1; 规划/08 BR-ID-07 细则「退出登录吊销
// 当前 sid」): revokes the session of the request's verified access token — only that sid, so the
// user's other devices keep their sessions. The token stages ② ③ already ran: a token whose
// session is revoked never gets here (10002 at stage ②), so repeating the call writes nothing.
// A session revoked by a concurrent request between stage ② and this transaction is answered the
// same way (10002). In that transaction, after the revocation, this session's push token binding
// is cleared through the push token port (拍板第二批 OPS-21; B1-12b): the conditional unbinding of
// (user, sid), so a row a later login on this device rebound is left as it is. A failed unbinding
// rolls the revocation back (50001).
// Erasable syntax only, like the rest of application/.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, TokenPrincipal } from '../../platform/index.ts';
import { TokenRejection } from './access-tokens.ts';
import type { SessionPushTokens } from './push-tokens.ts';
import { revokeSession } from './sessions.ts';

/** revoke_reason of a session ended by its own user (open text, 0013). */
export const LOGOUT_REVOKE_REASON = 'logout';

export interface Logout {
  logout(principal: TokenPrincipal): Promise<void>;
}

/**
 * Without a database handle (isolated HTTP unit tests) logout fails closed (50001). Without the
 * push token port (identity assembled without notification) only the session is revoked.
 */
export function createLogout(deps: {
  db: Kysely<DB> | undefined;
  clock: Clock;
  pushTokens?: SessionPushTokens | null;
}): Logout {
  const { db, clock } = deps;
  const pushTokens = deps.pushTokens ?? null;
  return {
    async logout(principal) {
      if (db === undefined) throw new Error('identity: no database handle in this process');
      const revoked = await db.transaction().execute(async (transaction) => {
        const ended = await revokeSession(
          transaction,
          { app_id: principal.app_id, sid: principal.sid, reason: LOGOUT_REVOKE_REASON },
          clock,
        );
        if (ended && pushTokens !== null) {
          await pushTokens.unbind(transaction, {
            app_id: principal.app_id,
            user_id: principal.uid,
            sid: principal.sid,
          });
        }
        return ended;
      });
      if (!revoked) throw new TokenRejection(10002);
    },
  };
}
