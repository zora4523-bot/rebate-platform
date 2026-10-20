// F1-02zk: SQL of the system-written switch port. Runs only inside the caller's transaction;
// same columns, jsonb encoding and version rules as kysely-kill-switch-store (admin writes).
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';
type Json = DB['config_items']['value'];

/** The locked or written row: only what the port decides on and reports. */
export interface SystemSwitchRow {
  readonly value: Json;
  readonly version: number;
}

/** One system write of the safe value; `reason` is already `<source>:<reason>`. */
export interface SystemSwitchWrite {
  readonly appId: string;
  readonly key: string;
  readonly updatedBy: string;
  readonly reason: string;
  readonly at: Date;
}

export interface SystemSwitchTx {
  /** SELECT … FOR UPDATE; undefined when the row does not exist yet. */
  lock(appId: string, key: string): Promise<SystemSwitchRow | undefined>;
  /** First write (version 1); undefined when a concurrent first write already committed. */
  insertOff(input: SystemSwitchWrite): Promise<SystemSwitchRow | undefined>;
  /** Conditional on the locked version, so it can never skip or reuse a version. */
  updateOff(input: SystemSwitchWrite, fromVersion: number): Promise<SystemSwitchRow | undefined>;
  history(input: SystemSwitchWrite, version: number): Promise<void>;
}

const COLUMNS = ['value', 'version'] as const;
const OFF = sql<Json>`'false'::jsonb`;

/** Statements bound to the caller's transaction; nothing here commits or opens a transaction. */
export function kyselySystemSwitchTx(trx: Transaction<DB>): SystemSwitchTx {
  const app = trx.withSchema('app');
  return {
    async lock(appId, key): Promise<SystemSwitchRow | undefined> {
      return app
        .selectFrom('config_items')
        .select(COLUMNS)
        .where('app_id', '=', appId)
        .where('key', '=', key)
        .forUpdate()
        .executeTakeFirst();
    },

    async insertOff(input): Promise<SystemSwitchRow | undefined> {
      return app
        .insertInto('config_items')
        .values({
          app_id: input.appId,
          key: input.key,
          value: OFF,
          version: 1,
          row_version: 0,
          updated_by: input.updatedBy,
          created_at: input.at,
          updated_at: input.at,
        })
        .onConflict((oc) => oc.columns(['app_id', 'key']).doNothing())
        .returning(COLUMNS)
        .executeTakeFirst();
    },

    async updateOff(input, fromVersion): Promise<SystemSwitchRow | undefined> {
      return app
        .updateTable('config_items')
        .set((eb) => ({
          value: OFF,
          version: eb('version', '+', 1),
          row_version: eb('row_version', '+', 1),
          updated_by: input.updatedBy,
          updated_at: input.at,
        }))
        .where('app_id', '=', input.appId)
        .where('key', '=', input.key)
        .where('version', '=', fromVersion)
        .returning(COLUMNS)
        .executeTakeFirst();
    },

    async history(input, version) {
      await app
        .insertInto('config_item_versions')
        .values({
          app_id: input.appId,
          key: input.key,
          version,
          value: OFF,
          updated_by: input.updatedBy,
          updated_by_admin_id: null,
          reason: input.reason,
          created_at: input.at,
        })
        .execute();
    },
  };
}
