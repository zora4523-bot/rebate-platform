// B1-10j: the reviewers' current display names for orders' console claim review (claim_items
// decided_by → AdminClaimItem.decided_by_name). Read only over admin_users by app_id and id;
// display_name, or login_name when display_name is empty. An id with no account of this app
// (deleted, another app) is absent from the answer; the caller shows null. app.module hands this
// to orders, so orders never reads admin's tables.
//
// Pure module (no decorators, erasable syntax).
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';

export interface AdminDisplayNameReader {
  /** admin_id → display name (display_name, else login_name); unknown ids are left out. */
  displayNames(appId: string, adminIds: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

export function createAdminDisplayNameReader(db: Kysely<DB>): AdminDisplayNameReader {
  return Object.freeze({
    async displayNames(appId: string, adminIds: readonly string[]) {
      const ids = [...new Set(adminIds)];
      const result = new Map<string, string>();
      if (ids.length === 0) return result;
      const rows = await db
        .withSchema('app')
        .selectFrom('admin_users')
        .select(['id', 'login_name', 'display_name'])
        .where('app_id', '=', appId)
        .where('id', '=', sql<string>`ANY(${ids}::uuid[])`)
        .execute();
      for (const row of rows) {
        const display = row.display_name;
        result.set(row.id, display === null || display === '' ? row.login_name : display);
      }
      return result;
    },
  });
}
