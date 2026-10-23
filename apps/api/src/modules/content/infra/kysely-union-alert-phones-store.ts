// F1-02zzj (D10-281): SQL of the union.auth_alert_phones dedicated write port. Runs only inside
// the caller's transaction; same columns, jsonb encoding and version rules as
// kysely-config-item-store (admin writes). The value is opaque: encoded as given, never read back.
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';

/** One port write; `value` is already the JSON text of the opaque object. */
export interface UnionAlertPhonesWrite {
  readonly appId: string;
  readonly key: string;
  readonly valueJson: string;
  readonly updatedBy: string;
  readonly adminId: string;
  readonly reason: string | null;
  readonly at: Date;
}

export interface UnionAlertPhonesTx {
  /** SELECT version … FOR UPDATE; undefined when the row does not exist yet. */
  lockVersion(appId: string, key: string): Promise<number | undefined>;
  /** First write (version 1); undefined when a concurrent first write already committed. */
  insert(input: UnionAlertPhonesWrite): Promise<number | undefined>;
  /** Conditional on the locked version; returns the new version, undefined on a miss. */
  update(input: UnionAlertPhonesWrite, fromVersion: number): Promise<number | undefined>;
  history(input: UnionAlertPhonesWrite, version: number): Promise<void>;
}

const jsonb = (text: string) => sql<DB['config_items']['value']>`${text}::jsonb`;

/** Statements bound to the caller's transaction; nothing here commits or opens a transaction. */
export function kyselyUnionAlertPhonesTx(trx: Transaction<DB>): UnionAlertPhonesTx {
  const app = trx.withSchema('app');
  return {
    async lockVersion(appId, key) {
      const row = await app
        .selectFrom('config_items')
        .select('version')
        .where('app_id', '=', appId)
        .where('key', '=', key)
        .forUpdate()
        .executeTakeFirst();
      return row?.version;
    },

    async insert(input) {
      const row = await app
        .insertInto('config_items')
        .values({
          app_id: input.appId,
          key: input.key,
          value: jsonb(input.valueJson),
          version: 1,
          row_version: 0,
          updated_by: input.updatedBy,
          created_at: input.at,
          updated_at: input.at,
        })
        .onConflict((oc) => oc.columns(['app_id', 'key']).doNothing())
        .returning('version')
        .executeTakeFirst();
      return row?.version;
    },

    async update(input, fromVersion) {
      const row = await app
        .updateTable('config_items')
        .set((eb) => ({
          value: jsonb(input.valueJson),
          version: eb('version', '+', 1),
          row_version: eb('row_version', '+', 1),
          updated_by: input.updatedBy,
          updated_at: input.at,
        }))
        .where('app_id', '=', input.appId)
        .where('key', '=', input.key)
        .where('version', '=', fromVersion)
        .returning('version')
        .executeTakeFirst();
      return row?.version;
    },

    async history(input, version) {
      await app
        .insertInto('config_item_versions')
        .values({
          app_id: input.appId,
          key: input.key,
          version,
          value: jsonb(input.valueJson),
          updated_by: input.updatedBy,
          updated_by_admin_id: input.adminId,
          reason: input.reason,
          created_at: input.at,
        })
        .execute();
    },
  };
}
