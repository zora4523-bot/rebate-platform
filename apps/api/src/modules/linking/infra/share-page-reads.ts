// B1-15u: the sharer's stored binding as the share page judges it (BR-ATTR-05 细则「别人的分享 link
// 不可用」): read only, never queried at the union and never written; any status but active
// (none, unbound, pending_auth, invalid, blocked, released) is an invalid sharer authorization.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ShareSharerBindings } from '../application/share-page.ts';

/** union_bindings.user_id is a uuid column: any other snapshot value has no binding. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createShareSharerBindings(db: Kysely<DB>): ShareSharerBindings {
  return {
    async active(appId, userId, platform) {
      if (!UUID.test(userId)) return false;
      const row = await db
        .selectFrom('union_bindings')
        .select('id')
        .where('app_id', '=', appId)
        .where('user_id', '=', userId)
        .where('platform', '=', platform)
        .where('status', '=', 'active')
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}
