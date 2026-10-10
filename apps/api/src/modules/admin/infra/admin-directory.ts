// Read-only queries of the admin accounts list and detail (F1-06m). Always the primary database
// (couli_app, the DB handle): couli_readonly cannot read the verify phone cipher (ruling §9.2 #1),
// so a configured read replica is never used here. Reads only; nothing is written or audited
// (ruling §9.2 #6). Scoped to one app_id; ordered by created_at, then id (ruling §9.2 #2).
//
// Pure module (no decorators, erasable syntax).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';

export interface AdminDirectoryRow {
  readonly id: string;
  readonly appId: string;
  readonly loginName: string;
  readonly isSuper: boolean;
  readonly status: string;
  readonly totpBoundAt: Date | null;
  readonly verifyPhoneCipher: Buffer | null;
  readonly lockedUntil: Date | null;
  readonly createdAt: Date;
  /** Raw permission keys ticked in admin_permissions (unfiltered). */
  readonly permissionKeys: readonly string[];
}

export interface AdminDirectory {
  /** Every account of the app (disabled included). */
  count(appId: string): Promise<number>;
  /** One page, created_at then id ascending. */
  page(appId: string, offset: number, limit: number): Promise<AdminDirectoryRow[]>;
  /** One account of the app; undefined when absent or of another app. `id` must be a UUID. */
  byId(appId: string, id: string): Promise<AdminDirectoryRow | undefined>;
}

const COLUMNS = [
  'id',
  'app_id',
  'login_name',
  'is_super',
  'status',
  'totp_bound_at',
  'verify_phone_cipher',
  'locked_until',
  'created_at',
] as const;

interface Row {
  id: string;
  app_id: string;
  login_name: string;
  is_super: boolean;
  status: string;
  totp_bound_at: Date | null;
  verify_phone_cipher: Buffer | null;
  locked_until: Date | null;
  created_at: Date;
}

export function createAdminDirectory(deps: { readonly db: Kysely<DB> }): AdminDirectory {
  const { db } = deps;

  const withPermissions = async (
    appId: string,
    rows: readonly Row[],
  ): Promise<AdminDirectoryRow[]> => {
    const keys = new Map<string, string[]>();
    if (rows.length > 0) {
      const ticked = await db
        .selectFrom('admin_permissions')
        .select(['admin_id', 'permission_key'])
        .where('app_id', '=', appId)
        .where(
          'admin_id',
          'in',
          rows.map((row) => row.id),
        )
        .execute();
      for (const { admin_id, permission_key } of ticked) {
        const list = keys.get(admin_id);
        if (list === undefined) keys.set(admin_id, [permission_key]);
        else list.push(permission_key);
      }
    }
    return rows.map((row) => ({
      id: row.id,
      appId: row.app_id,
      loginName: row.login_name,
      isSuper: row.is_super,
      status: row.status,
      totpBoundAt: row.totp_bound_at,
      verifyPhoneCipher: row.verify_phone_cipher,
      lockedUntil: row.locked_until,
      createdAt: row.created_at,
      permissionKeys: keys.get(row.id) ?? [],
    }));
  };

  return {
    async count(appId) {
      const row = await db
        .selectFrom('admin_users')
        .select((eb) => eb.fn.countAll<string>().as('total'))
        .where('app_id', '=', appId)
        .executeTakeFirstOrThrow();
      return Number(row.total);
    },

    async page(appId, offset, limit) {
      const rows = await db
        .selectFrom('admin_users')
        .select(COLUMNS)
        .where('app_id', '=', appId)
        .orderBy('created_at', 'asc')
        .orderBy('id', 'asc')
        .offset(offset)
        .limit(limit)
        .execute();
      return withPermissions(appId, rows);
    },

    async byId(appId, id) {
      const row = await db
        .selectFrom('admin_users')
        .select(COLUMNS)
        .where('app_id', '=', appId)
        .where('id', '=', id)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return (await withPermissions(appId, [row]))[0];
    },
  };
}
