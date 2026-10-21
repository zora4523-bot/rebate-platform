import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { ArticleStore } from '../application/article-reader.ts';
import { withHelpSection, type ArticleCategory } from '../domain/articles.ts';

/** SELECT only, app-scoped, on the primary handle. One statement gives each page a snapshot. */
export function createKyselyArticleStore(db: Kysely<DB>): ArticleStore {
  function published(appId: string, now: Date) {
    return db
      .withSchema('app')
      .selectFrom('articles as a')
      .where('a.app_id', '=', appId)
      .where('a.status', '=', 'published')
      .where('a.published_at', 'is not', null)
      .where('a.published_at', '<=', now);
  }

  const publishedAt = sql<string>`to_char(a.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

  return {
    async list({ appId, now, category, helpSection, after, take }) {
      let query = published(appId, now)
        .select([
          'a.id',
          'a.category',
          'a.title',
          'a.version',
          'a.notice_closable',
          'a.notice_content_version',
          'a.help_section',
        ])
        .select(publishedAt.as('published_at'))
        .select(
          sql<
            string | null
          >`to_char(a.notice_end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
            'notice_end_at',
          ),
        )
        // Pick the current revision before applying category, notice window or cursor. A newer
        // published revision in another category (or expired notice) must not resurrect an old one.
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('articles as newer')
                .select('newer.id')
                .where('newer.app_id', '=', appId)
                .whereRef('newer.id', '=', 'a.id')
                .whereRef('newer.version', '>', 'a.version')
                .where('newer.status', '=', 'published')
                .where('newer.published_at', 'is not', null)
                .where('newer.published_at', '<=', now),
            ),
          ),
        )
        .where('a.category', '=', category);
      // L30: the sub-section of the current revision, filtered in SQL before the page limit.
      if (helpSection !== undefined) query = query.where('a.help_section', '=', helpSection);
      if (category === 'notice') {
        query = query
          .where('a.title', '!=', '')
          .where((eb) =>
            eb.or([eb('a.notice_closable', '=', true), eb('a.notice_end_at', 'is not', null)]),
          )
          .where((eb) =>
            eb.or([eb('a.notice_end_at', 'is', null), eb('a.notice_end_at', '>', now)]),
          );
      }
      if (after !== undefined) {
        query = query.where(
          sql<boolean>`(a.published_at, a.id) < (${after.at}::timestamptz, ${after.id}::uuid)`,
        );
      }
      return query.orderBy('a.published_at', 'desc').orderBy('a.id', 'desc').limit(take).execute();
    },

    async detail({ appId, now, id, version }) {
      let query = published(appId, now)
        .select(['a.id', 'a.category', 'a.title', 'a.version', 'a.body', 'a.help_section'])
        .select(publishedAt.as('published_at'))
        .where('a.id', '=', id);
      if (version !== undefined) query = query.where('a.version', '=', version);
      const row = await query.orderBy('a.version', 'desc').limit(1).executeTakeFirst();
      if (row === undefined) return null;
      const category = row.category as ArticleCategory; // articles_category_check
      return withHelpSection(category, row.help_section, {
        article_id: row.id,
        category,
        title: row.title,
        version: row.version,
        published_at: row.published_at,
        body: row.body,
      });
    },
  };
}
