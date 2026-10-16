import type { ClientPlatform } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type {
  AppVersionRowStore,
  ContentConfig,
  ContentStore,
} from '../application/content-reader.ts';
import type { AppVersionRow } from '../domain/app-version.ts';

/**
 * ContentStore over the primary handle (ADR-0001 §4.2 #11 keeps dbRead for admin reports).
 * Issues SELECT only, so a handle holding nothing but SELECT on both tables suffices.
 */
export function createKyselyContentStore(db: Kysely<DB>): ContentStore & AppVersionRowStore {
  return {
    async minSupportedVersionsByChannel(
      appId: string,
      platform: ClientPlatform,
    ): Promise<ReadonlyMap<string, string | null>> {
      const rows = await db
        .selectFrom('app_versions')
        .select(['channel', 'min_supported_version'])
        .where('app_id', '=', appId)
        .where('platform', '=', platform)
        .execute();
      return new Map(rows.map((row) => [row.channel, row.min_supported_version]));
    },

    async appVersionsByChannel(
      appId: string,
      platform: ClientPlatform,
    ): Promise<ReadonlyMap<string, AppVersionRow>> {
      const rows = await db
        .selectFrom('app_versions')
        .selectAll()
        .where('app_id', '=', appId)
        .where('platform', '=', platform)
        .execute();
      return new Map(rows.map((row) => [row.channel, row]));
    },

    async configItem(appId: string, key: string): Promise<ContentConfig | null> {
      const row = await db
        .selectFrom('config_items')
        .select(['value', 'version'])
        .where('app_id', '=', appId)
        .where('key', '=', key)
        .executeTakeFirst();
      return row === undefined ? null : { value: row.value, version: row.version };
    },
  };
}
