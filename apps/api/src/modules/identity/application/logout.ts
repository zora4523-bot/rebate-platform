// Contract operation `logout` (POST /v1/auth/logout; 04 §6.1; 规划/08 BR-ID-07 细则「退出登录吊销
// 当前 sid」): revokes the session of the request's verified access token — only that sid, so the
// user's other devices keep their sessions. The token stages ② ③ already ran: a token whose
// session is revoked never gets here (10002 at stage ②), so repeating the call writes nothing.
// A session revoked by a concurrent request between stage ② and this transaction is answered the
// same way (10002). Unbinding this device's push token from the user (拍板第二批 OPS-21) joins the
// same transaction with B1-12b; until then logout revokes the session only (§9.5 #11).
// Erasable syntax only, like the rest of application/.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, TokenPrincipal } from '../../platform/index.ts';
import { TokenRejection } from './access-tokens.ts';
import { revokeSession } from './sessions.ts';

/** revoke_reason of a session ended by its own user (open text, 0013). */
export const LOGOUT_REVOKE_REASON = 'logout';

export interface Logout {
  logout(principal: TokenPrincipal): Promise<void>;
}

/** Without a database handle (isolated HTTP unit tests) logout fails closed (50001). */
export function createLogout(deps: { db: Kysely<DB> | undefined; clock: Clock }): Logout {
  const { db, clock } = deps;
  return {
    async logout(principal) {
      if (db === undefined) throw new Error('identity: no database handle in this process');
      const revoked = await db
        .transaction()
        .execute((transaction) =>
          revokeSession(
            transaction,
            { app_id: principal.app_id, sid: principal.sid, reason: LOGOUT_REVOKE_REASON },
            clock,
          ),
        );
      if (!revoked) throw new TokenRejection(10002);
    },
  };
}
