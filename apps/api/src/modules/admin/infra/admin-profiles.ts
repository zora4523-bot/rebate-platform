// Reads of the signed-in admin account for step-up and GET /admin/v1/me/permissions (F1-06l; 04
// §11; 08 BR-ID-34): its name, super flag and verify phone cipher (admin_users), and its ticked
// permission keys (admin_permissions). Reads only; the admin module is the only writer of both
// tables (规划/02 §4.1).
//
// Pure module (no decorators, erasable syntax).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface AdminProfile {
  readonly id: string;
  readonly appId: string;
  readonly loginName: string;
  readonly isSuper: boolean;
  readonly status: string;
  /** Field cipher text of the registered verify phone; null when none is registered. */
  readonly verifyPhoneCipher: Buffer | null;
}

export interface AdminProfiles {
  byId(appId: string, id: string): Promise<AdminProfile | undefined>;
  /** Every permission key ticked for the account (unknown keys included; callers filter). */
  permissionKeys(appId: string, id: string): Promise<readonly string[]>;
}

export function createAdminProfiles(deps: { readonly db: Kysely<DB> }): AdminProfiles {
  const { db } = deps;
  return {
    async byId(appId, id) {
      const row = await db
        .selectFrom('admin_users')
        .select(['id', 'app_id', 'login_name', 'is_super', 'status', 'verify_phone_cipher'])
        .where('app_id', '=', appId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        id: row.id,
        appId: row.app_id,
        loginName: row.login_name,
        isSuper: row.is_super,
        status: row.status,
        verifyPhoneCipher: row.verify_phone_cipher,
      };
    },

    async permissionKeys(appId, id) {
      const rows = await db
        .selectFrom('admin_permissions')
        .select('permission_key')
        .where('app_id', '=', appId)
        .where('admin_id', '=', id)
        .execute();
      return rows.map((row) => row.permission_key);
    },
  };
}
