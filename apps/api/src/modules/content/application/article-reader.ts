import type { Schema } from '@couli/contracts-ts';
import type { Clock } from '../../platform/index.ts';
import {
  articleSummary,
  decodeArticleCursor,
  encodeArticleCursor,
  isArticleId,
  type ArticleCategory,
  type ArticleCursor,
  type PublishedArticleSummary,
} from '../domain/articles.ts';

export interface ArticleListQuery {
  readonly category: ArticleCategory;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ArticleStore {
  /** Current published revisions only; category, notice eligibility and keyset precede limit. */
  list(input: {
    readonly appId: string;
    readonly now: Date;
    readonly category: ArticleCategory;
    readonly after: ArticleCursor | undefined;
    readonly take: number;
  }): Promise<readonly PublishedArticleSummary[]>;
  detail(input: {
    readonly appId: string;
    readonly now: Date;
    readonly id: string;
    readonly version: number | undefined;
  }): Promise<Schema<'Article'> | null>;
}

/** Fresh primary-database reads on every request, independent of ContentReader's TTL cache. */
export class ArticleReader {
  readonly #store: ArticleStore | null;
  readonly #clock: Clock;

  constructor(store: ArticleStore | null, clock: Clock) {
    this.#store = store;
    this.#clock = clock;
  }

  async list(appId: string, query: ArticleListQuery): Promise<Schema<'ArticleListData'>> {
    const limit = query.limit ?? 20; // Limit is validated by the contract route schema.
    const after =
      query.cursor === undefined ? undefined : decodeArticleCursor(query.cursor, query.category);
    const rows = await this.#available().list({
      appId,
      now: this.#clock.now(),
      category: query.category,
      after,
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(articleSummary),
      next_cursor:
        rows.length > limit && last !== undefined
          ? encodeArticleCursor(query.category, { at: last.published_at, id: last.id })
          : null,
    };
  }

  async detail(appId: string, id: string, version?: number): Promise<Schema<'Article'> | null> {
    if (!isArticleId(id)) return null;
    return this.#available().detail({ appId, id, version, now: this.#clock.now() });
  }

  #available(): ArticleStore {
    if (this.#store === null) throw new Error('content: article reads need the database');
    return this.#store;
  }
}
