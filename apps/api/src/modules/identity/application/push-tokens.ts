// identity's port onto notification's push token commands (规划/08 BR-ID-07 细则「推送令牌与会话」;
// B1-12b). notification owns push_tokens; identity calls the two commands inside the transaction
// that creates or ends a session, and never imports notification: app.module builds this port from
// notification's index.ts and hands it to IdentityModule.forRoot (dependency inversion, so the
// module graph has no identity → notification edge and no cycle).
//   - bind: every path that creates a session (createSession's afterCreated), after the device row
//     is locked and last_login_sid written;
//   - unbind: the conditional unbinding of one ended session (user_id, sid) — logout, the refresh
//     reuse revocation, revocation by user or by device. unbindRevoked turns it into the
//     AfterSessionsRevoked hook: it reads the ended sessions' user_id from identity's own sessions
//     table (same transaction) and sends one command per session.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { AfterSessionsRevoked } from './revoke-sessions.ts';

export interface SessionPushTokens {
  bind(
    trx: Transaction<DB>,
    session: {
      readonly app_id: string;
      readonly user_id: string;
      readonly device_id: string;
      readonly sid: string;
    },
  ): Promise<void>;
  unbind(
    trx: Transaction<DB>,
    session: { readonly app_id: string; readonly user_id: string; readonly sid: string },
  ): Promise<void>;
}

/** The unbinding hook of a revocation: one conditional command per revoked session. */
export function unbindRevoked(pushTokens: SessionPushTokens): AfterSessionsRevoked {
  return async (trx, sids, context) => {
    if (sids.length === 0) return;
    const sessions = await trx
      .selectFrom('sessions')
      .select(['user_id', 'sid'])
      .where('app_id', '=', context.app_id)
      .where('sid', 'in', sids)
      .orderBy('sid')
      .execute();
    for (const session of sessions) {
      await pushTokens.unbind(trx, {
        app_id: context.app_id,
        user_id: session.user_id,
        sid: session.sid,
      });
    }
  };
}
