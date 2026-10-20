import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { AuditPort } from '../../platform/index.ts';
import type {
  KillSwitchRow,
  KillSwitchStore,
  KillSwitchTx,
} from '../application/kill-switch-admin.ts';
import { currentConfigValues, lockInviteReward } from './invite-reward-guard.ts';

const COLUMNS = ['key', 'value', 'version', 'updated_by', 'updated_at'] as const;

function switchRow(row: {
  key: string;
  value: DB['config_items']['value'];
  version: number;
  updated_by: string;
  updated_at: Date;
}): KillSwitchRow {
  return {
    key: row.key,
    value: row.value,
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

function writeTx(trx: Kysely<DB>, audit: AuditPort): KillSwitchTx {
  const app = trx.withSchema('app');
  return {
    async lock(appId, key) {
      const row = await app
        .selectFrom('config_items')
        .select(COLUMNS)
        .where('app_id', '=', appId)
        .where('key', '=', key)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined ? undefined : switchRow(row);
    },

    async change(input) {
      const values = {
        // JSON primitives must be encoded as jsonb too (not raw PG text for enum strings).
        value: sql<DB['config_items']['value']>`${JSON.stringify(input.value)}::jsonb`,
        updated_by: input.actor.loginName,
        updated_at: input.at,
      };
      const row =
        input.expectedVersion === 0
          ? await app
              .insertInto('config_items')
              .values({
                app_id: input.actor.appId,
                key: input.key,
                ...values,
                version: 1,
                row_version: 0,
                created_at: input.at,
              })
              .onConflict((oc) => oc.columns(['app_id', 'key']).doNothing())
              .returning(COLUMNS)
              .executeTakeFirst()
          : await app
              .updateTable('config_items')
              .set((eb) => ({
                ...values,
                version: eb('version', '+', 1),
                row_version: eb('row_version', '+', 1),
              }))
              .where('app_id', '=', input.actor.appId)
              .where('key', '=', input.key)
              .where('version', '=', input.expectedVersion)
              .returning(COLUMNS)
              .executeTakeFirst();
      return row === undefined ? undefined : switchRow(row);
    },

    async history(input, version) {
      await app
        .insertInto('config_item_versions')
        .values({
          app_id: input.actor.appId,
          key: input.key,
          version,
          value: sql`${JSON.stringify(input.value)}::jsonb`,
          updated_by: input.actor.loginName,
          updated_by_admin_id: input.actor.adminId,
          reason: input.reason,
          created_at: input.at,
        })
        .execute();
    },

    lockInviteReward: (appId) => lockInviteReward(trx, appId),

    values: (appId, keys) => currentConfigValues(trx, appId, keys),

    audit: (input) => audit.append(input),
  };
}

/** Primary connection only; history and admin's audit port share the write transaction. */
export function createKyselyKillSwitchStore(
  db: Kysely<DB>,
  auditWriter: (trx: Kysely<DB>) => AuditPort,
): KillSwitchStore {
  return {
    async rows(appId) {
      const rows = await db
        .withSchema('app')
        .selectFrom('config_items')
        .select(COLUMNS)
        .where('app_id', '=', appId)
        .execute();
      return rows.map(switchRow);
    },
    transaction: (work) => db.transaction().execute((trx) => work(writeTx(trx, auditWriter(trx)))),
  };
}
