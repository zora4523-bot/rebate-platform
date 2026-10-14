// Push token binding to sessions (规划/08 BR-ID-07 细则「推送令牌与会话」: 绑定代际、登录时绑定、
// 解绑一律是条件更新; migration 0008 push_tokens, notification is its only writer).
// Both commands run inside the caller's transaction (identity's session creation or revocation),
// so a failed token write rolls the session write back with it. Each is one UPDATE of
// push_tokens through the query builder (CAS entity: row_version + 1, updated_at from the Clock):
//
// bindPushTokensForSession — called after identity locked the device row and wrote
//   last_login_sid = the new sid: every token row of that device in the app that is not revoked
//   and not frozen (frozen_until empty, or ≤ the Clock's now) gets (user_id, bound_sid) = the new
//   session. No row, nothing is written (the token report creates rows, not the login). The token
//   value and token_set_at are untouched.
// unbindPushTokensForSession — the only unbinding command: user_id and bound_sid are cleared only
//   where both equal the ended session's (user_id, sid) in that app; the row stays (no delete, no
//   revocation). A later login already rebound the row → no match, nothing changes. There is no
//   unconditional per-device unbinding.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface SessionBinding {
  readonly app_id: string;
  readonly user_id: string;
  readonly device_id: string;
  readonly sid: string;
}

export interface SessionUnbinding {
  readonly app_id: string;
  readonly user_id: string;
  readonly sid: string;
}

/** Called after identity locks the device and writes last_login_sid, in that transaction. */
export async function bindPushTokensForSession(
  transaction: Transaction<DB>,
  session: SessionBinding,
  clock: Clock,
): Promise<void> {
  const now = clock.now();
  await transaction
    .updateTable('push_tokens')
    .set((eb) => ({
      user_id: session.user_id,
      bound_sid: session.sid,
      row_version: eb('row_version', '+', 1),
      updated_at: now,
    }))
    .where('app_id', '=', session.app_id)
    .where('device_id', '=', session.device_id)
    .where('revoked_at', 'is', null)
    .where((eb) => eb.or([eb('frozen_until', 'is', null), eb('frozen_until', '<=', now)]))
    .execute();
}

/** Conditional (app_id, user_id, bound_sid) update; there is no device-only unbind command. */
export async function unbindPushTokensForSession(
  transaction: Transaction<DB>,
  session: SessionUnbinding,
  clock: Clock,
): Promise<void> {
  const now = clock.now();
  await transaction
    .updateTable('push_tokens')
    .set((eb) => ({
      user_id: null,
      bound_sid: null,
      row_version: eb('row_version', '+', 1),
      updated_at: now,
    }))
    .where('app_id', '=', session.app_id)
    .where('user_id', '=', session.user_id)
    .where('bound_sid', '=', session.sid)
    .execute();
}
