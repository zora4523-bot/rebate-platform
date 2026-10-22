// B1-12o: identity's read-only port for notification's pre-send check (BR-ID-07 细则「发送前校验」).
// Given a recipient and some session ids, answers which of them are still usable for a push: the
// session belongs to that recipient in that app, is not revoked, and has an unrotated refresh row
// whose expire_at is strictly later than the injected Clock's now. One SELECT on the caller's
// executor (so an uncommitted revocation in the caller's transaction is seen); never writes.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface PushSessionQuery {
  readonly app_id: string;
  readonly user_id: string;
  readonly sids: readonly string[];
}

/** Read only: requested recipient sessions with an unrotated refresh row expiring after now. */
export type PushSessionValidity = (
  executor: Kysely<DB> | Transaction<DB>,
  query: PushSessionQuery,
) => Promise<ReadonlySet<string>>;

/** All joins are app-scoped; revoked, absent and expired sessions are excluded. */
export function createPushSessionValidity(clock: Clock): PushSessionValidity {
  return async (executor, query) => {
    const sids = [...new Set(query.sids)];
    if (sids.length === 0) return new Set<string>();
    const now = clock.now();
    const rows = await executor
      .withSchema('app')
      .selectFrom('sessions as s')
      .select('s.sid')
      .where('s.app_id', '=', query.app_id)
      .where('s.user_id', '=', query.user_id)
      .where('s.sid', 'in', sids)
      .where('s.revoked_at', 'is', null)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom('refresh_tokens as r')
            .select('r.id')
            .whereRef('r.app_id', '=', 's.app_id')
            .whereRef('r.sid', '=', 's.sid')
            .where('r.rotated_at', 'is', null)
            .where('r.expire_at', '>', now),
        ),
      )
      .execute();
    return new Set(rows.map((row) => row.sid));
  };
}
