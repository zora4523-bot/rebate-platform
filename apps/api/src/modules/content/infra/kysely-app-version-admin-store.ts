// F1-02zc: app.app_versions for the console (content is the table's only writer). Primary handle
// only: the pre-read that chooses the step-up tier, the reads and the save transaction (row lock,
// write and admin's audit row on one transaction). Grants: couli_app has SELECT, INSERT, UPDATE.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { AuditPort } from '../../platform/index.ts';
import {
  AppVersionConflictError,
  type AppVersionAdminStore,
  type AppVersionRecord,
  type AppVersionTx,
  type AppVersionWrite,
} from '../application/app-version-admin.ts';

const COLUMNS = [
  'platform',
  'channel',
  'latest_version',
  'min_supported_version',
  'recommended_version',
  'update_title',
  'update_notes',
  'store_url',
  'default_store',
  'store_listings',
  'row_version',
  'updated_at',
] as const;

/** PostgreSQL unique_violation: a concurrent first save of the same platform and channel. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

function values(write: AppVersionWrite) {
  const { row } = write;
  return {
    latest_version: row.latest_version,
    min_supported_version: row.min_supported_version,
    recommended_version: row.recommended_version,
    update_title: row.update_title,
    update_notes: row.update_notes,
    store_url: row.store_url,
    default_store: row.default_store,
    // Request order kept as written (jsonb arrays keep their order).
    store_listings: sql<DB['app_versions']['store_listings']>`${JSON.stringify(
      row.store_listings,
    )}::jsonb`,
    updated_at: write.at,
  };
}

function writeTx(trx: Kysely<DB>, audit: AuditPort): AppVersionTx {
  const app = trx.withSchema('app');
  return {
    lock: (appId, platform, channel) =>
      app
        .selectFrom('app_versions')
        .select(COLUMNS)
        .where('app_id', '=', appId)
        .where('platform', '=', platform)
        .where('channel', '=', channel)
        .forUpdate()
        .executeTakeFirst(),

    async insert(id, write) {
      try {
        return await app
          .insertInto('app_versions')
          .values({
            id,
            app_id: write.appId,
            platform: write.row.platform,
            channel: write.row.channel,
            ...values(write),
            row_version: 0,
            created_at: write.at,
          })
          .onConflict((oc) => oc.columns(['app_id', 'platform', 'channel']).doNothing())
          .returning(COLUMNS)
          .executeTakeFirst();
      } catch (error) {
        // Belt and braces: any unique violation of a first save is the CAS conflict (20902).
        if (isUniqueViolation(error)) return undefined;
        throw error;
      }
    },

    update: (write, rowVersion) =>
      app
        .updateTable('app_versions')
        .set((eb) => ({ ...values(write), row_version: eb('row_version', '+', 1) }))
        .where('app_id', '=', write.appId)
        .where('platform', '=', write.row.platform)
        .where('channel', '=', write.row.channel)
        .where('row_version', '=', rowVersion)
        .returning(COLUMNS)
        .executeTakeFirst(),

    audit: (input) => audit.append(input),
  };
}

export function createKyselyAppVersionAdminStore(
  db: Kysely<DB>,
  auditWriter: (trx: Kysely<DB>) => AuditPort,
): AppVersionAdminStore {
  const app = db.withSchema('app');
  return {
    rows: (appId): Promise<AppVersionRecord[]> =>
      app
        .selectFrom('app_versions')
        .select(COLUMNS)
        .where('app_id', '=', appId)
        .orderBy('platform')
        .orderBy('channel')
        .execute(),

    row: (appId, platform, channel) =>
      app
        .selectFrom('app_versions')
        .select(COLUMNS)
        .where('app_id', '=', appId)
        .where('platform', '=', platform)
        .where('channel', '=', channel)
        .executeTakeFirst(),

    async transaction(work) {
      try {
        return await db.transaction().execute((trx) => work(writeTx(trx, auditWriter(trx))));
      } catch (error) {
        // A unique violation surfacing at commit is the same lost race as ON CONFLICT (20902).
        if (isUniqueViolation(error)) throw new AppVersionConflictError();
        throw error;
      }
    },
  };
}
