// B3-08i (BR-AI-04 数据源「规则答复」: agent_rule_chunks only from CMS published versions; BR-AI-07
// T6 rule_ref excerpt ≤ 200 字; ledger notes 切块 / 触发 / content 只读入口; D10-194: no vectors).
// Tiptap body builders (articles.body is tiptap JSON, F1-02m) and a real-PG fixture as couli_app.
// The one-shot database is created by each *.int.test.ts (createTestDatabase passed in): this kit
// imports nothing from the database testing package, neither as a value nor as a type.
// D10-386 (as B3-08k): content's reader is built here with the database and the Clock, the way
// app.module assembles it, and handed to syncRuleChunks; agent gets the reader, never content's
// function plus a database handle.
import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect } from 'vitest';
import {
  syncRuleChunks,
  type RuleChunkSyncResult,
} from '../../../../apps/api/src/modules/agent/rag/chunks/index.ts';
import {
  createPublishedArticlesReader,
  type PublishedArticle,
  type PublishedArticlesReader,
} from '../../../../apps/api/src/modules/content/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';

/** agent_rule_chunks_text_check and the rule_ref excerpt limit, in characters (code points). */
export const MAX_CHARS = 200;
export const TITLE = '返利结算规则';
/** When the fixture articles went live. */
export const PUBLISHED_AT = new FixedClock('2026-10-20T00:00:00.000Z').now();
/** The sync's clock. */
export const NOW = new FixedClock('2026-10-27T08:00:00.000Z').now();
export const LATER = new FixedClock('2026-10-27T09:00:00.000Z').now();
export const TOMORROW = new FixedClock('2026-10-28T08:00:00.000Z').now();
const MEDIA = 'https://media.example.test/rules/synthetic.png';

export type Node = Record<string, unknown>;
export type Row = Record<string, unknown>;

// ---- tiptap builders ----------------------------------------------------------------------

export function text(value: string, ...marks: ('bold' | 'italic')[]): Node {
  return marks.length === 0
    ? { type: 'text', text: value }
    : { type: 'text', text: value, marks: marks.map((type) => ({ type })) };
}

export const BR: Node = { type: 'hardBreak' };
export const RULE: Node = { type: 'horizontalRule' };
export const IMAGE: Node = { type: 'image', attrs: { src: MEDIA, alt: '示意图', title: null } };

/** Strings become text nodes; an empty call is an empty paragraph (no content). */
export function paragraph(...parts: (string | Node)[]): Node {
  if (parts.length === 0) return { type: 'paragraph' };
  return {
    type: 'paragraph',
    content: parts.map((part) => (typeof part === 'string' ? text(part) : part)),
  };
}

export function heading(level: 1 | 2 | 3, value: string): Node {
  return { type: 'heading', attrs: { level }, content: [text(value)] };
}

export function bulletList(...items: Node[][]): Node {
  return {
    type: 'bulletList',
    content: items.map((blocks) => ({ type: 'listItem', content: blocks })),
  };
}

export function orderedList(...items: Node[][]): Node {
  return {
    type: 'orderedList',
    attrs: { start: 1 },
    content: items.map((blocks) => ({ type: 'listItem', content: blocks })),
  };
}

export function blockquote(...blocks: Node[]): Node {
  return { type: 'blockquote', content: blocks };
}

/** The stored body string. */
export function doc(...blocks: Node[]): string {
  return JSON.stringify({ type: 'doc', content: blocks });
}

/** A body of one short paragraph per text. */
export function bodyOf(...paragraphs: string[]): string {
  return doc(...paragraphs.map((value) => paragraph(value)));
}

export function codePoints(value: string): number {
  return Array.from(value).length;
}

/** No unpaired UTF-16 surrogate (a cut never splits a code point). */
export function wellFormed(value: string): boolean {
  return value.isWellFormed();
}

// ---- real PG -------------------------------------------------------------------------------

/** The one-shot database a test file creates (createTestDatabase, passed in by *.int.test.ts). */
export interface FixtureDatabase {
  urlFor(role: string): string;
  drop(): Promise<void>;
}

export type Category = 'help' | 'rule' | 'notice' | 'agreement';
export type Status = 'draft' | 'published' | 'offline';

export interface ArticleInput {
  readonly appId: string;
  readonly id?: string;
  readonly category?: Category;
  readonly title?: string;
  readonly body?: string;
  readonly version?: number;
  readonly status?: Status;
  /** Defaults: PUBLISHED_AT unless the status is draft (then null). */
  readonly publishedAt?: Date | null;
}

export interface StoredArticle {
  readonly id: string;
  readonly app_id: string;
  readonly version: number;
  readonly title: string;
  readonly body: string;
  readonly published_at: Date | null;
}

export interface ChunkInput {
  readonly appId: string;
  readonly articleId: string;
  readonly version: number;
  readonly seq: number;
  readonly text: string;
  readonly title?: string;
  readonly chunkId?: string;
}

export function newAppId(): string {
  return `synthetic-rag-chunks-${randomUUID()}`;
}

function insert(db: Kysely<DB>, table: string, row: Row) {
  const names = Object.keys(row);
  return sql`INSERT INTO ${sql.table(`app.${table}`)}
    (${sql.join(names.map((name) => sql.ref(name)))})
    VALUES (${sql.join(names.map((name) => row[name]))})`.execute(db);
}

export function databaseKit(createDatabase: () => Promise<FixtureDatabase>) {
  let database: FixtureDatabase | undefined;
  let pool: Kysely<DB> | undefined;
  beforeAll(async () => {
    database = await createDatabase();
    pool = createDb({ connectionString: database.urlFor('couli_app'), max: 4 });
  }, 180_000);
  afterAll(async () => {
    if (pool) await destroyDb(pool);
    if (database) await database.drop();
  });

  function db(): Kysely<DB> {
    expect(pool, 'PG fixture is ready').toBeDefined();
    return pool!;
  }

  /** One version row of an article, as the CMS stores it. */
  async function article(input: ArticleInput): Promise<StoredArticle> {
    const status = input.status ?? 'published';
    let publishedAt: Date | null = status === 'draft' ? null : PUBLISHED_AT;
    if (input.publishedAt !== undefined) publishedAt = input.publishedAt;
    const row: StoredArticle = {
      id: input.id ?? randomUUID(),
      app_id: input.appId,
      version: input.version ?? 1,
      title: input.title ?? TITLE,
      body: input.body ?? bodyOf('确认收货后返利进入待结算。'),
      published_at: publishedAt,
    };
    await insert(db(), 'articles', {
      ...row,
      category: input.category ?? 'help',
      status,
      notice_closable: false,
    });
    return row;
  }

  /** Every version row of the article gets the status (the CMS offline / restore of a fixture). */
  async function setStatus(id: string, status: Status): Promise<void> {
    await sql`UPDATE app.articles SET status = ${status} WHERE id = ${id}`.execute(db());
  }

  /** A chunk row written directly (an earlier sync, or an earlier delivery of this one). */
  async function chunk(input: ChunkInput): Promise<string> {
    const chunkId = input.chunkId ?? randomUUID();
    await insert(db(), 'agent_rule_chunks', {
      chunk_id: chunkId,
      app_id: input.appId,
      article_id: input.articleId,
      published_version: input.version,
      seq: input.seq,
      title: input.title ?? TITLE,
      text: input.text,
    });
    return chunkId;
  }

  /** Every chunk row of the app, all columns, in (article_id, published_version, seq) order. */
  async function chunks(appId: string): Promise<Row[]> {
    const result = await sql<Row>`SELECT * FROM app.agent_rule_chunks WHERE app_id = ${appId}
      ORDER BY article_id, published_version, seq`.execute(db());
    return result.rows;
  }

  async function articles(appId: string): Promise<Row[]> {
    const result = await sql<Row>`SELECT * FROM app.articles WHERE app_id = ${appId}
      ORDER BY id, version`.execute(db());
    return result.rows;
  }

  /** content's reader over the fixture database, on the given Clock (app.module's assembly). */
  function reader(at: Date = NOW): PublishedArticlesReader {
    return createPublishedArticlesReader({ db: db(), clock: new FixedClock(at) });
  }

  /** One sync with the given reader (a stand-in, or content's real one) on the given Clock. */
  function syncWith(
    appId: string,
    source: PublishedArticlesReader,
    at: Date = NOW,
  ): Promise<RuleChunkSyncResult> {
    return syncRuleChunks({ db: db(), clock: new FixedClock(at), articles: source }, appId);
  }

  /** One sync as wired: content's reader and the sync share the Clock. */
  function sync(appId: string, at: Date = NOW): Promise<RuleChunkSyncResult> {
    return syncWith(appId, reader(at), at);
  }

  function published(appId: string, at: Date = NOW): Promise<readonly PublishedArticle[]> {
    return reader(at).list(appId);
  }

  /**
   * app.module's assembly kept across calls: one Clock and one reader built once, reused by every
   * later list / sync (the agent worker's periodic sync). Move the Clock with clock.set(...).
   */
  function wiring(at: Date = NOW) {
    const clock = new FixedClock(at);
    const source = createPublishedArticlesReader({ db: db(), clock });
    return {
      clock,
      list: (appId: string) => source.list(appId),
      sync: (appId: string) => syncRuleChunks({ db: db(), clock, articles: source }, appId),
    };
  }

  return { db, article, setStatus, chunk, chunks, articles, sync, syncWith, published, wiring };
}

/** The (article, version, seq, title, text, status) view of stored rows (no generated values). */
export function shapeOf(rows: readonly Row[]): Row[] {
  return rows.map((row) => ({
    article_id: row['article_id'],
    published_version: row['published_version'],
    seq: row['seq'],
    title: row['title'],
    text: row['text'],
    status: row['status'],
  }));
}

/** Expected active chunks of one article version, one per text, seq from 0. */
export function activeOf(
  article: Pick<StoredArticle, 'id' | 'version'>,
  texts: readonly string[],
  title: string = TITLE,
): Row[] {
  return texts.map((value, seq) => ({
    article_id: article.id,
    published_version: article.version,
    seq,
    title,
    text: value,
    status: 'active',
  }));
}

/** Same rows with status retired (shapeOf view). */
export function retiredOf(rows: readonly Row[]): Row[] {
  return rows.map((row) => ({ ...row, status: 'retired' }));
}

/** shapeOf rows sorted as chunks() orders them (article_id, published_version, seq). */
export function sortedShape(rows: readonly Row[]): Row[] {
  // Lowercase canonical UUID text compares like PG's bytewise uuid order; no locale collation.
  return [...rows].sort((a, b) => {
    const left = String(a['article_id']);
    const right = String(b['article_id']);
    const article = left < right ? -1 : left > right ? 1 : 0;
    if (article !== 0) return article;
    const version = Number(a['published_version']) - Number(b['published_version']);
    return version !== 0 ? version : Number(a['seq']) - Number(b['seq']);
  });
}
