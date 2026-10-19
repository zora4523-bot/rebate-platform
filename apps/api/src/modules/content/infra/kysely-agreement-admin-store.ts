// F1-02p: agreements (content is its single writer), the agreement article rows, legal.* config
// rows with their history, all on the primary handle; admin's audit port shares each publish
// transaction. Times are written explicitly from the injected Clock, never left to now() defaults.
// published_by is returned as the admin uuid (no join of admin_users).
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { AuditPort } from '../../platform/index.ts';
import type {
  AgreementDetailView,
  AgreementReads,
  AgreementStore,
  AgreementTx,
  AgreementView,
} from '../application/agreement-admin.ts';
import type { AgreementType } from '../domain/agreements/index.ts';

const VERSION_KEY = 'agreements_app_type_version_key';

/** A unique violation of agreements (app_id, type, version): another publish won (→ 20902). */
export function isAgreementVersionTaken(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const pg = error as { code?: unknown; constraint?: unknown };
  return pg.code === '23505' && pg.constraint === VERSION_KEY;
}

const VIEW_COLUMNS = [
  'g.type',
  'g.version',
  'g.min_version',
  'g.requires_resign',
  'g.article_id',
  'g.article_version',
  'g.text_sha256',
  'g.url',
  'g.legal_confirmed_by',
  'g.legal_confirm_note',
  'g.published_at',
  'g.published_by',
] as const;

interface ViewRow {
  type: string;
  version: number;
  min_version: number;
  requires_resign: boolean;
  article_id: string;
  article_version: number;
  text_sha256: string;
  url: string;
  legal_confirmed_by: string;
  legal_confirm_note: string;
  published_at: Date;
  published_by: string;
}

function view(row: ViewRow): AgreementView {
  return {
    type: row.type as AgreementType,
    version: row.version,
    min_version: row.min_version,
    requires_resign: row.requires_resign,
    article_id: row.article_id,
    article_version: row.article_version,
    text_sha256: row.text_sha256,
    url: row.url,
    legal_confirmed_by: row.legal_confirmed_by,
    legal_confirm_note: row.legal_confirm_note,
    published_at: row.published_at.toISOString(),
    published_by: row.published_by,
  };
}

function reads(db: Kysely<DB>): AgreementReads {
  const app = db.withSchema('app');
  return {
    list: (appId, type, offset, limit) =>
      // One read-only REPEATABLE READ snapshot: the page and its total see the same committed rows.
      db
        .transaction()
        .setIsolationLevel('repeatable read')
        .setAccessMode('read only')
        .execute(async (trx) => {
          const scoped = () => {
            const base = trx
              .withSchema('app')
              .selectFrom('agreements as g')
              .where('g.app_id', '=', appId);
            return type === undefined ? base : base.where('g.type', '=', type);
          };
          const rows = await scoped()
            .select(VIEW_COLUMNS)
            .orderBy('g.published_at', 'desc')
            .orderBy('g.version', 'desc')
            .orderBy('g.type')
            .limit(limit)
            .offset(offset)
            .execute();
          const total = await scoped()
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .executeTakeFirstOrThrow();
          return { items: rows.map(view), total: Number(total.n) };
        }),

    async detail(appId, type, version) {
      const row = await app
        .selectFrom('agreements as g')
        .innerJoin('articles as a', (join) =>
          join
            .onRef('a.id', '=', 'g.article_id')
            .onRef('a.version', '=', 'g.article_version')
            .onRef('a.app_id', '=', 'g.app_id'),
        )
        .select(VIEW_COLUMNS)
        .select(['a.title', 'a.body'])
        .where('g.app_id', '=', appId)
        .where('g.type', '=', type)
        .where('g.version', '=', version)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      const detail: AgreementDetailView = { ...view(row), title: row.title, body: row.body };
      return detail;
    },
  };
}

function writeTx(trx: Kysely<DB>, audit: AuditPort): AgreementTx {
  const app = trx.withSchema('app');
  return {
    async lock(appId, type) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`agreement:${appId}:${type}`}, 0))`.execute(
        trx,
      );
    },

    async current(appId, type) {
      return app
        .selectFrom('agreements')
        .select(['version', 'min_version', 'requires_resign', 'article_id'])
        .where('app_id', '=', appId)
        .where('type', '=', type)
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirst();
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

    async lockConfig(appId, key) {
      const row = await app
        .selectFrom('config_items')
        .select(['value', 'version'])
        .where('app_id', '=', appId)
        .where('key', '=', key)
        .forUpdate()
        .executeTakeFirst();
      return row === undefined ? undefined : { value: row.value as unknown, version: row.version };
    },

    articleRevisions: (articleId) =>
      app
        .selectFrom('articles')
        .select(['app_id', 'version', 'row_version'])
        .where('id', '=', articleId)
        .orderBy('version', 'desc')
        .execute(),

    async insertArticle(row) {
      await app
        .insertInto('articles')
        .values({
          id: row.id,
          app_id: row.appId,
          category: 'agreement',
          title: row.title,
          body: row.body,
          version: row.version,
          status: 'published',
          published_at: row.at,
          notice_closable: false,
          notice_content_version: 1,
          notice_end_at: null,
          row_version: row.rowVersion,
          created_at: row.at,
          updated_at: row.at,
        })
        .execute();
    },

    async insertAgreement(row) {
      await app
        .insertInto('agreements')
        .values({
          id: row.id,
          app_id: row.appId,
          type: row.type,
          version: row.version,
          min_version: row.minVersion,
          requires_resign: row.requiresResign,
          article_id: row.articleId,
          article_version: row.articleVersion,
          text_sha256: row.textSha256,
          url: row.url,
          legal_confirmed_by: row.legalConfirmedBy,
          legal_confirm_note: row.legalConfirmNote,
          published_at: row.at,
          published_by: row.publishedBy,
          created_at: row.at,
        })
        .execute();
    },

    async writeConfig(input) {
      const value = sql<DB['config_items']['value']>`${JSON.stringify(input.value)}::jsonb`;
      if (input.existing === undefined) {
        await app
          .insertInto('config_items')
          .values({
            app_id: input.appId,
            key: input.key,
            value,
            version: 1,
            row_version: 0,
            updated_by: input.loginName,
            created_at: input.at,
            updated_at: input.at,
          })
          .execute();
        return 1;
      }
      // The row is locked FOR UPDATE in this transaction; the version guard is belt and braces.
      const row = await app
        .updateTable('config_items')
        .set((eb) => ({
          value,
          version: eb('version', '+', 1),
          row_version: eb('row_version', '+', 1),
          updated_by: input.loginName,
          updated_at: input.at,
        }))
        .where('app_id', '=', input.appId)
        .where('key', '=', input.key)
        .where('version', '=', input.existing.version)
        .returning('version')
        .executeTakeFirst();
      if (row === undefined) throw new Error(`agreement: ${input.key} changed while locked`);
      return row.version;
    },

    async history(input, version) {
      await app
        .insertInto('config_item_versions')
        .values({
          app_id: input.appId,
          key: input.key,
          version,
          value: sql`${JSON.stringify(input.value)}::jsonb`,
          updated_by: input.loginName,
          updated_by_admin_id: input.adminId,
          reason: 'agreement_publish',
          created_at: input.at,
        })
        .execute();
    },

    audit: (input) => audit.append(input),
  };
}

/** Primary connection only; agreement, article, config, history and audit share one transaction. */
export function createKyselyAgreementAdminStore(
  db: Kysely<DB>,
  auditWriter: (trx: Kysely<DB>) => AuditPort,
): AgreementStore {
  return {
    ...reads(db),
    transaction: (work) => db.transaction().execute((trx) => work(writeTx(trx, auditWriter(trx)))),
  };
}
