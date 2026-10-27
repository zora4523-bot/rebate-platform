// B3-08i: the read-only reader of the published help / rule articles of one app, for the agent's
// rule chunk sync (08 BR-AI-04 数据源「规则答复」: agent_rule_chunks only from CMS published
// versions). One item per article: its current revision, i.e. the largest version whose status is
// exactly published and whose published_at is not later than the Clock (04 §6.2, currentVersionOf),
// and only when that revision's category is help or rule. SELECT only on app.articles, app-scoped,
// read fresh on every call (no cache). app.module builds the reader and hands it to agent (D10-386,
// as B3-08k): the agent never queries app.articles and never passes a database handle to content.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface PublishedArticlesReaderOptions {
  /** Primary handle (ADR-0001 §4.2 #11); the reader only reads. */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
}

/** The current published revision of one help / rule article. */
export interface PublishedArticle {
  readonly id: string;
  readonly app_id: string;
  readonly version: number;
  readonly title: string;
  /** Stored body (tiptap JSON, F1-02m). */
  readonly body: string;
  readonly published_at: Date;
}

export interface PublishedArticlesReader {
  list(appId: string): Promise<readonly PublishedArticle[]>;
}

export function createPublishedArticlesReader(
  options: PublishedArticlesReaderOptions,
): PublishedArticlesReader {
  const { db, clock } = options;
  return {
    async list(appId) {
      const now = clock.now();
      const rows = await db
        .withSchema('app')
        .selectFrom('articles as a')
        .select(['a.id', 'a.app_id', 'a.version', 'a.title', 'a.body', 'a.published_at'])
        .where('a.app_id', '=', appId)
        .where('a.status', '=', 'published')
        .where('a.published_at', 'is not', null)
        .where('a.published_at', '<=', now)
        // Pick the current revision before the category filter: a newer published revision in
        // another category must not resurrect an older help / rule one.
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
        .where('a.category', 'in', ['help', 'rule'])
        .orderBy('a.id')
        .execute();
      const result: PublishedArticle[] = [];
      for (const row of rows) {
        if (row.published_at === null) continue; // Filtered above; narrows the type.
        result.push({
          id: row.id,
          app_id: row.app_id,
          version: row.version,
          title: row.title,
          body: row.body,
          published_at: row.published_at,
        });
      }
      return result;
    },
  };
}
