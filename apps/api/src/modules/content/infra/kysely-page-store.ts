import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { PageStore } from '../application/page-reader.ts';

/** SELECT only, app-scoped, by primary key, on the primary handle (F1-09d). */
export function createKyselyPageStore(db: Kysely<DB>): PageStore {
  return {
    async pointer(appId, pageKey) {
      const row = await db
        .withSchema('app')
        .selectFrom('pages')
        .select(['current_version', 'gray_version', 'gray_percent'])
        .where('app_id', '=', appId)
        .where('page_key', '=', pageKey)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        currentVersion: row.current_version,
        grayVersion: row.gray_version,
        grayPercent: row.gray_percent,
      };
    },
    async version(appId, pageKey, version) {
      const row = await db
        .withSchema('app')
        .selectFrom('page_versions')
        .select(['status', 'sections'])
        .where('app_id', '=', appId)
        .where('page_key', '=', pageKey)
        .where('version', '=', version)
        .executeTakeFirst();
      if (row === undefined) return null;
      return {
        status: row.status,
        // jsonb array of section objects (page_versions_sections_check); anything else serves nothing.
        sections: Array.isArray(row.sections)
          ? (row.sections as unknown as Record<string, unknown>[])
          : [],
      };
    },
  };
}
