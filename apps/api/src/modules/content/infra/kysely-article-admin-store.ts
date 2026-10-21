// F1-02w: the console's article rows (content is the single writer of articles), on the primary
// handle; admin's audit port shares each write transaction. Times are written explicitly from the
// injected Clock, never left to now() defaults. Updates touch only the five columns migration 0049
// grants couli_app (status, published_at, notice_end_at, row_version, updated_at).
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { AuditPort } from '../../platform/index.ts';
import type {
  ArticleAdminReads,
  ArticleAdminStore,
  ArticleAdminTx,
  ArticleRow,
  ArticleVersionStatus,
} from '../application/article-admin.ts';
import {
  withHelpSection,
  type ArticleCategory,
  type ArticleHelpSection,
} from '../domain/articles.ts';

const PRIMARY_KEY = 'articles_pkey';

/** A primary key violation of articles (id, version): a concurrent write took it (→ 20902). */
export function isArticleVersionTaken(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const pg = error as { code?: unknown; constraint?: unknown };
  return pg.code === '23505' && pg.constraint === PRIMARY_KEY;
}

const ROW_COLUMNS = [
  'id',
  'app_id',
  'category',
  'title',
  'body',
  'version',
  'status',
  'published_at',
  'notice_closable',
  'notice_content_version',
  'notice_end_at',
  'help_section',
  'row_version',
  'created_at',
  'updated_at',
] as const;

interface StoredRow {
  id: string;
  app_id: string;
  category: string;
  title: string;
  body: string;
  version: number;
  status: string;
  published_at: Date | null;
  notice_closable: boolean;
  notice_content_version: number;
  notice_end_at: Date | null;
  help_section: string | null;
  row_version: number;
  created_at: Date;
  updated_at: Date;
}

function articleRow(row: StoredRow): ArticleRow {
  return {
    ...row,
    category: row.category as ArticleCategory,
    status: row.status as ArticleVersionStatus,
    help_section: row.help_section as ArticleHelpSection | null, // articles_help_section_check
  };
}

function rowsOf(db: Kysely<DB>, appId: string, articleId: string): Promise<ArticleRow[]> {
  return db
    .withSchema('app')
    .selectFrom('articles')
    .select(ROW_COLUMNS)
    .where('app_id', '=', appId)
    .where('id', '=', articleId)
    .orderBy('version', 'desc')
    .execute()
    .then((rows) => rows.map(articleRow));
}

interface SummaryRow {
  id: string;
  category: string;
  title: string;
  version: number;
  status: string;
  row_version: number;
  updated_at: Date;
  help_section: string | null;
  current_version: number | null;
  current_published_at: Date | null;
}

function reads(db: Kysely<DB>): ArticleAdminReads {
  return {
    async list({ appId, now, category, status, offset, limit }) {
      // The newest row of every id of the app; filters apply to it (编排者默认).
      const latest = sql`select distinct on (a.id) a.id, a.category, a.title, a.version,
        a.status, a.row_version, a.updated_at, a.help_section
        from app.articles a where a.app_id = ${appId} order by a.id, a.version desc`;
      const filters = sql`where true
        ${category === undefined ? sql`` : sql`and l.category = ${category}`}
        ${status === undefined ? sql`` : sql`and l.status = ${status}`}`;
      const [page, count] = await Promise.all([
        sql<SummaryRow>`with latest as (${latest})
          select l.id, l.category, l.title, l.version, l.status, l.row_version, l.updated_at,
            l.help_section,
            cur.version as current_version, cur.published_at as current_published_at
          from latest l
          left join lateral (
            select c.version, c.published_at from app.articles c
            where c.app_id = ${appId} and c.id = l.id and c.status = 'published'
              and c.published_at is not null and c.published_at <= ${now}
            order by c.version desc limit 1
          ) cur on true
          ${filters}
          order by l.updated_at desc, l.id asc
          limit ${limit} offset ${offset}`.execute(db),
        sql<{ n: string }>`with latest as (${latest})
          select count(*) as n from latest l ${filters}`.execute(db),
      ]);
      return {
        // L30: help_section of the newest row, only when set.
        items: page.rows.map((row) => {
          const category = row.category as ArticleCategory;
          return withHelpSection(category, row.help_section, {
            article_id: row.id,
            category,
            title: row.title,
            latest_version: row.version,
            latest_status: row.status as ArticleVersionStatus,
            current_version: row.current_version,
            published_at: row.current_published_at?.toISOString() ?? null,
            row_version: row.row_version,
            updated_at: row.updated_at.toISOString(),
          });
        }),
        total: Number(count.rows[0]?.n ?? 0),
      };
    },

    rows: (appId, articleId) => rowsOf(db, appId, articleId),
  };
}

function writeTx(trx: Kysely<DB>, audit: AuditPort): ArticleAdminTx {
  const app = trx.withSchema('app');
  return {
    async lock(appId, articleId) {
      const locked = await app
        .selectFrom('articles')
        .select('version')
        .where('app_id', '=', appId)
        .where('id', '=', articleId)
        .forUpdate()
        .execute();
      return locked.length > 0;
    },

    // A separate statement after the lock: READ COMMITTED gives it a fresh snapshot, so a version
    // a concurrent save inserted while this one waited is seen (and the CAS refuses).
    rows: (appId, articleId) => rowsOf(trx, appId, articleId),

    async taken(articleId) {
      const row = await app
        .selectFrom('articles')
        .select('version')
        .where('id', '=', articleId)
        .limit(1)
        .executeTakeFirst();
      return row !== undefined;
    },

    async configValue(appId, key) {
      const row = await app
        .selectFrom('config_items')
        .select('value')
        .where('app_id', '=', appId)
        .where('key', '=', key)
        .executeTakeFirst();
      return row === undefined ? undefined : (row.value as unknown);
    },

    async insert(row) {
      await app.insertInto('articles').values(row).execute();
    },

    async update(appId, articleId, version, expectedRowVersion, set) {
      const updated = await app
        .updateTable('articles')
        .set({
          ...(set.status === undefined ? {} : { status: set.status }),
          ...(set.published_at === undefined ? {} : { published_at: set.published_at }),
          ...(set.notice_end_at === undefined ? {} : { notice_end_at: set.notice_end_at }),
          ...(set.row_version === undefined ? {} : { row_version: set.row_version }),
          updated_at: set.updated_at,
        })
        .where('app_id', '=', appId)
        .where('id', '=', articleId)
        .where('version', '=', version)
        .where('row_version', '=', expectedRowVersion)
        .executeTakeFirst();
      return updated.numUpdatedRows === 1n;
    },

    audit: (input) => audit.append(input),
  };
}

/** Primary connection only; article rows and the audit row share one transaction. */
export function createKyselyArticleAdminStore(
  db: Kysely<DB>,
  auditWriter: (trx: Kysely<DB>) => AuditPort,
): ArticleAdminStore {
  return {
    ...reads(db),
    transaction: (work) => db.transaction().execute((trx) => work(writeTx(trx, auditWriter(trx)))),
  };
}
