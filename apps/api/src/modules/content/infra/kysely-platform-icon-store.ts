import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { AuditPort } from '../../platform/index.ts';
import type {
  PlatformIconRow,
  PlatformIconStore,
  PlatformIconVersionRow,
} from '../application/platform-icon-reader.ts';
import type {
  PlatformIconEditor,
  PlatformIconWriteStore,
  PlatformIconWriteTx,
} from '../application/platform-icon-writer.ts';

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

/**
 * The app's marks with their current versions in ONE statement (LEFT JOIN): current_version and
 * current always come from the same snapshot, also while a publish commits in between.
 */
async function iconRows(db: Kysely<DB>, appId: string, key?: string): Promise<PlatformIconRow[]> {
  let query = db
    .withSchema('app')
    .selectFrom('platform_icons as i')
    .leftJoin('platform_icon_versions as v', (join) =>
      join
        .onRef('v.app_id', '=', 'i.app_id')
        .onRef('v.key', '=', 'i.key')
        .onRef('v.version', '=', 'i.current_version'),
    )
    .select([
      'i.key as mark_key',
      'i.current_version as mark_current_version',
      'i.revision as mark_revision',
      'i.updated_by as mark_updated_by',
      'i.updated_at as mark_updated_at',
      ...VERSION_COLUMNS,
      downloadedOn,
    ])
    .where('i.app_id', '=', appId);
  if (key !== undefined) query = query.where('i.key', '=', key);
  const rows = await query.execute();
  return rows.map((row) => ({
    key: row.mark_key,
    currentVersion: row.mark_current_version,
    revision: row.mark_revision,
    updatedBy: row.mark_updated_by,
    updatedAt: row.mark_updated_at,
    current:
      row.mark_current_version === null || row.version === null
        ? null
        : versionRow(row as VersionSelect),
  }));
}

async function latestOf(db: Kysely<DB>, appId: string, key: string): Promise<number | null> {
  const row = await db
    .withSchema('app')
    .selectFrom('platform_icon_versions')
    .select((eb) => eb.fn.max('version').as('latest'))
    .where('app_id', '=', appId)
    .where('key', '=', key)
    .executeTakeFirst();
  return row?.latest === undefined || row.latest === null ? null : Number(row.latest);
}

/** Primary couli_app handle; tenant-scoped SELECTs in schema app. */
export function createKyselyPlatformIconStore(db: Kysely<DB>): PlatformIconStore {
  const app = db.withSchema('app');
  return {
    icons: (appId) => iconRows(db, appId),

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

/** Published marks of one app (current_version set), each with its version's file facts. */
export async function publishedIconRows(
  db: Kysely<DB>,
  appId: string,
): Promise<{ key: string; version: number; sha256: string; format: string }[]> {
  return db
    .withSchema('app')
    .selectFrom('platform_icons as i')
    .innerJoin('platform_icon_versions as v', (join) =>
      join
        .onRef('v.app_id', '=', 'i.app_id')
        .onRef('v.key', '=', 'i.key')
        .onRef('v.version', '=', 'i.current_version'),
    )
    .select(['i.key', 'v.version', 'v.sha256', 'v.format'])
    .where('i.app_id', '=', appId)
    .where('i.current_version', 'is not', null)
    .orderBy('i.key')
    .execute();
}

function writeTx(trx: Kysely<DB>, audit: AuditPort): PlatformIconWriteTx {
  const app = trx.withSchema('app');
  const editorColumns = (editor: PlatformIconEditor) => ({
    updated_by: editor.loginName,
    updated_by_admin_id: editor.adminId,
    updated_at: editor.at,
  });
  return {
    async lockMark(appId, key) {
      // Lock order everywhere: the mark row first, then a version row (no deadlock between a
      // registration and a publish of the same mark). An absent mark gets its row at revision 0.
      await app
        .insertInto('platform_icons')
        .values({ app_id: appId, key })
        .onConflict((oc) => oc.columns(['app_id', 'key']).doNothing())
        .execute();
      const row = await app
        .selectFrom('platform_icons')
        .select(['current_version', 'revision'])
        .where('app_id', '=', appId)
        .where('key', '=', key)
        .forUpdate()
        .executeTakeFirstOrThrow();
      return { currentVersion: row.current_version, revision: row.revision };
    },

    async registration(appId, key, version) {
      const row = await app
        .selectFrom('platform_icon_versions')
        .select(['source_url', 'downloaded_on', 'ever_published'])
        .where('app_id', '=', appId)
        .where('key', '=', key)
        .where('version', '=', version)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : {
            hasSourceUrl: row.source_url !== null,
            hasDownloadedOn: row.downloaded_on !== null,
            everPublished: row.ever_published,
          };
    },

    async updateRegistration(appId, key, version, expectedRevision, patch) {
      const values: { source_url?: string; downloaded_on?: string; revision: number } = {
        revision: expectedRevision + 1,
      };
      if (patch.sourceUrl !== undefined) values.source_url = patch.sourceUrl;
      if (patch.downloadedOn !== undefined) values.downloaded_on = patch.downloadedOn;
      const row = await app
        .updateTable('platform_icon_versions as v')
        .set(values)
        .where('v.app_id', '=', appId)
        .where('v.key', '=', key)
        .where('v.version', '=', version)
        .where('v.revision', '=', expectedRevision)
        .where('v.ever_published', '=', false)
        .returning([...VERSION_COLUMNS, downloadedOn])
        .executeTakeFirst();
      return row === undefined ? undefined : versionRow(row);
    },

    async version(appId, key, version) {
      const row = await app
        .selectFrom('platform_icon_versions as v')
        .select([...VERSION_COLUMNS, downloadedOn])
        .where('v.app_id', '=', appId)
        .where('v.key', '=', key)
        .where('v.version', '=', version)
        .executeTakeFirst();
      return row === undefined ? undefined : versionRow(row);
    },

    async setCurrent(appId, key, expectedRevision, currentVersion, editor) {
      const updated = await app
        .updateTable('platform_icons')
        .set({
          current_version: currentVersion,
          revision: expectedRevision + 1,
          ...editorColumns(editor),
        })
        .where('app_id', '=', appId)
        .where('key', '=', key)
        .where('revision', '=', expectedRevision)
        .returning('revision')
        .executeTakeFirst();
      return updated !== undefined;
    },

    async markPublished(appId, key, version) {
      await app
        .updateTable('platform_icon_versions')
        .set({ ever_published: true })
        .where('app_id', '=', appId)
        .where('key', '=', key)
        .where('version', '=', version)
        .where('ever_published', '=', false)
        .execute();
    },

    async touchMark(appId, key, editor) {
      await app
        .updateTable('platform_icons')
        .set(editorColumns(editor))
        .where('app_id', '=', appId)
        .where('key', '=', key)
        .execute();
    },

    async icon(appId, key) {
      const [row] = await iconRows(trx, appId, key);
      return { row, latestVersion: await latestOf(trx, appId, key) };
    },

    audit: (input) => audit.append(input),
  };
}

/** Writes in one transaction each; the audit row is appended on that same transaction. */
export function createKyselyPlatformIconWriteStore(
  db: Kysely<DB>,
  auditWriter: (trx: Kysely<DB>) => AuditPort,
): PlatformIconWriteStore {
  return {
    transaction: (work) => db.transaction().execute((trx) => work(writeTx(trx, auditWriter(trx)))),
  };
}
