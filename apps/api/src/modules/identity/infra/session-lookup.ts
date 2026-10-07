// The session read of stage ② (规划/08 BR-ID-01 ②, BR-ID-07): app.sessions by (app_id, sid), read
// from the primary on every authenticated request so that a revocation (logout, B1-02k's reuse
// detection, an admin revocation) applies to the very next request (orchestrator ruling B1-02h
// §9.3 #2; a cache may come later). Written only by identity (规划/02 §4.1).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { SessionLookup } from '../application/access-tokens.ts';

/**
 * Without a database handle (isolated HTTP unit tests) every lookup rejects, so a request with an
 * otherwise valid token fails closed (50001) instead of passing unchecked.
 */
export function createSessionLookup(db: Kysely<DB> | undefined): SessionLookup {
  return {
    async find(appId, sid) {
      if (db === undefined) throw new Error('identity: no database handle in this process');
      const row = await db
        .selectFrom('sessions')
        .select('revoked_at')
        .where('app_id', '=', appId)
        .where('sid', '=', sid)
        .executeTakeFirst();
      return row === undefined ? null : { revoked_at: row.revoked_at };
    },
  };
}
