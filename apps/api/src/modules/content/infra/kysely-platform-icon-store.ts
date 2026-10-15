import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type {
  PlatformIconStore,
  PlatformIconVersionRow,
} from '../application/platform-icon-reader.ts';

const VERSION_COLUMNS = [
  'v.version',
  'v.sha256',
  'v.format',
  'v.bytes',
  'v.sanitized',
  'v.source_url',
  'v.ever_published',
  'v.revision',
  'v.created_by',
  'v.created_at',
] as const;

interface VersionSelect {
  readonly version: number;
  readonly sha256: string;
  readonly format: string;
  readonly bytes: number;
  readonly sanitized: boolean;
  readonly source_url: string | null;
  readonly downloaded_on: string | null;
  readonly ever_published: boolean;
  readonly revision: number;
  readonly created_by: string;
  readonly created_at: Date;
}

// A DATE column read as text: pg would otherwise parse it into a Date at local midnight.
const downloadedOn = sql<string | null>`to_char(v.downloaded_on, 'YYYY-MM-DD')`.as('downloaded_on');

function versionRow(row: VersionSelect): PlatformIconVersionRow {
  return {
    version: row.version,
    sha256: row.sha256,
    format: row.format,
    bytes: row.bytes,
    sanitized: row.sanitized,
    sourceUrl: row.source_url,
    downloadedOn: row.downloaded_on,
    everPublished: row.ever_published,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

/** Primary couli_app handle; tenant-scoped SELECTs in schema app. */
export function createKyselyPlatformIconStore(db: Kysely<DB>): PlatformIconStore {
  const app = db.withSchema('app');
  return {
    async icons(appId) {
      const marks = await app
        .selectFrom('platform_icons as i')
        .select(['i.key', 'i.current_version', 'i.revision', 'i.updated_by', 'i.updated_at'])
        .where('i.app_id', '=', appId)
        .execute();
      const current = await app
        .selectFrom('platform_icons as i')
        .innerJoin('platform_icon_versions as v', (join) =>
          join
            .onRef('v.app_id', '=', 'i.app_id')
            .onRef('v.key', '=', 'i.key')
            .onRef('v.version', '=', 'i.current_version'),
        )
        .select(['i.key', ...VERSION_COLUMNS, downloadedOn])
        .where('i.app_id', '=', appId)
        .execute();
      const currentByKey = new Map(current.map((row) => [row.key, versionRow(row)]));
      return marks.map((mark) => ({
        key: mark.key,
        currentVersion: mark.current_version,
        revision: mark.revision,
        updatedBy: mark.updated_by,
        updatedAt: mark.updated_at,
        current: mark.current_version === null ? null : (currentByKey.get(mark.key) ?? null),
      }));
    },

    async latestVersions(appId) {
      const rows = await app
        .selectFrom('platform_icon_versions')
        .select(['key', (eb) => eb.fn.max('version').as('latest')])
        .where('app_id', '=', appId)
        .groupBy('key')
        .execute();
      return new Map(rows.map((row) => [row.key, Number(row.latest)]));
    },

    async versionPage(appId, key, offset, limit) {
      const counted = await app
        .selectFrom('platform_icon_versions')
        .select((eb) => eb.fn.countAll<string>().as('total'))
        .where('app_id', '=', appId)
        .where('key', '=', key)
        .executeTakeFirstOrThrow();
      const rows = await app
        .selectFrom('platform_icon_versions as v')
        .select([...VERSION_COLUMNS, downloadedOn])
        .where('v.app_id', '=', appId)
        .where('v.key', '=', key)
        .orderBy('v.version', 'desc')
        .offset(offset)
        .limit(limit)
        .execute();
      return { total: Number(counted.total), items: rows.map(versionRow) };
    },
  };
}
