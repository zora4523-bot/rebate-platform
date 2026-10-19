// F1-02w: the console's article CMS (/admin/v1/articles*; contract adminListArticles,
// adminGetArticle, adminCreateArticle, adminSaveArticleDraft, adminPublishArticle,
// adminOfflineArticle; 04 §6.2 / §6.6 articles; 编排者裁定 F1-02w 9.2, decisions L15 / L18 / L19 /
// L27 / L32 / L34–L37 / L41 / L48 / L49).
// Reads: one row per article from its newest version row (list), every version newest first
// (detail); current_version = the largest version whose status is exactly published and whose
// published_at is not later than the Clock. Writes run in one transaction each; any refusal throws
// so the article rows and the audit row roll back together:
//   create  article_id lowercase canonical UUIDv7 → category agreement → save checks → id taken
//           anywhere (any app, L48) → insert version 1 draft (A1) → audit.
//   save    article_id → lock the id's rows → category agreement → save checks → CAS → insert
//           newest + 1 draft (A1, never in place, L19) → audit.
//   publish article_id → lock → category agreement → CAS → newest draft / published_at → save
//           checks of the stored row → A2 on the newest row (+1 row_version) → audit.
//   offline article_id → lock → category agreement → CAS → any published row → A3 on each
//           published row (notice_end_at for notices) and +1 row_version on the newest → audit.
// CAS (L36): the article's row_version is the newest row's. Only status, published_at,
// notice_end_at, row_version and updated_at are ever updated (migration 0049 grants).
// TODO(规划/11 §1.1): JEV-05 semantic pre-check on save (01 F-ADM-14, highlight only) — blocked on
// the judge module not existing yet (L21).
import type { Schema } from '@couli/contracts-ts';
import { transitionArticleVersion, type ArticleVersionEvent } from '@couli/domain';
import type { AuditInput, Clock, LinkPatternsSpec } from '../../platform/index.ts';
import type { ArticleCategory } from '../domain/articles.ts';
import { isArticleId } from '../domain/articles.ts';
import {
  nextNoticeContentVersion,
  validateArticleSave,
  type ArticleSaveInput,
} from '../domain/articles-admin/index.ts';
import type { BannedWord } from '../domain/text-guard/index.ts';
import { mediaHostsOf } from './agreement-admin.ts';

export type ArticleVersionStatus = Schema<'ArticleVersionStatus'>;

export interface ArticleAdminActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}
export interface ArticleAdminQuery {
  readonly page?: number;
  readonly page_size?: number;
  readonly category?: Schema<'ArticleCategory'>;
  readonly status?: Schema<'ArticleVersionStatus'>;
}

/** One stored version row of an article. */
export interface ArticleRow {
  readonly id: string;
  readonly app_id: string;
  readonly category: ArticleCategory;
  readonly title: string;
  readonly body: string;
  readonly version: number;
  readonly status: ArticleVersionStatus;
  readonly published_at: Date | null;
  readonly notice_closable: boolean;
  readonly notice_content_version: number;
  readonly notice_end_at: Date | null;
  readonly row_version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface ArticleListFilter {
  readonly appId: string;
  readonly now: Date;
  readonly category: ArticleCategory | undefined;
  readonly status: ArticleVersionStatus | undefined;
  readonly offset: number;
  readonly limit: number;
}

export interface ArticleAdminReads {
  /** Newest row per id of the app, filtered, newest updated_at first (id ascending on ties). */
  list(
    filter: ArticleListFilter,
  ): Promise<{ items: Schema<'AdminArticleSummary'>[]; total: number }>;
  /** Every version row of the id in the app, newest first. */
  rows(appId: string, articleId: string): Promise<readonly ArticleRow[]>;
}

/** The columns an article version row may change (0049 column grants). */
export interface ArticleRowUpdate {
  readonly status?: ArticleVersionStatus;
  readonly published_at?: Date;
  readonly notice_end_at?: Date;
  readonly row_version?: number;
  readonly updated_at: Date;
}

export interface ArticleAdminTx {
  /** FOR UPDATE on every row of the id in the app; false when the app has none. */
  lock(appId: string, articleId: string): Promise<boolean>;
  /** Every version row of the id in the app, newest first, read by a fresh statement. */
  rows(appId: string, articleId: string): Promise<readonly ArticleRow[]>;
  /** True when any app has a row with this id (the primary key has no app_id, L48). */
  taken(articleId: string): Promise<boolean>;
  /** Raw config_items value read inside the transaction (undefined = no row), never cached. */
  configValue(appId: string, key: string): Promise<unknown>;
  insert(row: ArticleRow): Promise<void>;
  /**
   * Updates one version row only while its row_version still equals `expectedRowVersion`;
   * false when no row matched.
   */
  update(
    appId: string,
    articleId: string,
    version: number,
    expectedRowVersion: number,
    set: ArticleRowUpdate,
  ): Promise<boolean>;
  audit(input: AuditInput): Promise<void>;
}

export interface ArticleAdminStore extends ArticleAdminReads {
  transaction<T>(work: (tx: ArticleAdminTx) => Promise<T>): Promise<T>;
}

export interface ArticleAdminOptions {
  readonly store: ArticleAdminStore;
  readonly clock: Clock;
  /** MEDIA_PUBLIC_BASE_URL as configured (L27); undefined admits no image host. */
  readonly mediaPublicBaseUrl: string | undefined;
  readonly linkPatterns: () => LinkPatternsSpec;
  readonly bannedWords: () => readonly BannedWord[];
  /** True for a primary key violation of articles: a concurrent write took the version. */
  readonly isVersionTaken: (error: unknown) => boolean;
}

export class ArticleFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`article: invalid ${fields.join(', ')}`);
    this.name = 'ArticleFieldsError';
    this.fields = fields;
  }
}

export class ArticleConflictError extends Error {
  constructor() {
    super('article: row_version conflict');
    this.name = 'ArticleConflictError';
  }
}

export class ArticleNotFoundError extends Error {
  constructor() {
    super('article: no such article');
    this.name = 'ArticleNotFoundError';
  }
}

const UNION_HOST_BLOCK = 'external_page.union_host_block';
const HELP_LINKS = 'help_links';
const HELP_LINKS_PREFIX = `${HELP_LINKS}.`;
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A new article's id: a lowercase canonical UUIDv7 (contract adminCreateArticle). */
export function isNewArticleId(value: string): boolean {
  return value.length === 36 && UUID_V7.test(value);
}

/**
 * L32 / L37: field names and words first, then body paths written as `body…` (the whole body for
 * an empty path), each listed once in first-seen order.
 */
export function articleFieldList(fields: readonly string[], paths: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of [...fields, ...paths.map((p) => (p === '' ? 'body' : `body.${p}`))]) {
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/** Largest published version already due at `now` (04 §6.2), null when none. */
export function currentVersionOf(rows: readonly ArticleRow[], now: Date): ArticleRow | undefined {
  let best: ArticleRow | undefined;
  for (const row of rows) {
    if (row.status !== 'published' || row.published_at === null) continue;
    if (row.published_at.getTime() > now.getTime()) continue;
    if (best === undefined || row.version > best.version) best = row;
  }
  return best;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The `allow_articles` config keys that currently point at this article (编排默认 9.2#7): a key
 * `help_links.<entry>` matches when config `help_links` has `<entry>.params.article_id` equal to
 * the id (client-config's HelpLinkTarget shape). Other key families are not recognised.
 */
export function articleConfigKeysFor(
  articleId: string,
  words: readonly BannedWord[],
  helpLinks: unknown,
): string[] {
  const links = plainObject(helpLinks);
  const keys: string[] = [];
  for (const word of words) {
    for (const rule of word.allow_articles ?? []) {
      const key = rule.config_key;
      if (keys.includes(key) || !key.startsWith(HELP_LINKS_PREFIX)) continue;
      const params = plainObject(plainObject(links?.[key.slice(HELP_LINKS_PREFIX.length)])?.params);
      if (params?.['article_id'] === articleId) keys.push(key);
    }
  }
  return keys;
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function articleView(rows: readonly ArticleRow[], now: Date): Schema<'AdminArticle'> {
  const newest = rows[0];
  if (newest === undefined) throw new ArticleNotFoundError();
  return {
    article_id: newest.id,
    category: newest.category,
    row_version: newest.row_version,
    current_version: currentVersionOf(rows, now)?.version ?? null,
    versions: rows.map((row) => ({
      version: row.version,
      status: row.status,
      title: row.title,
      body: row.body,
      notice_closable: row.notice_closable,
      notice_content_version: row.notice_content_version,
      notice_end_at: iso(row.notice_end_at),
      published_at: iso(row.published_at),
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    })),
  };
}

/** Audit facts of a version row: flat JSON scalars, never the body. */
type Facts = Record<string, string | number | null>;

function facts(row: ArticleRow): Facts {
  return {
    version: row.version,
    status: row.status,
    row_version: row.row_version,
    published_at: iso(row.published_at),
  };
}

function transition(from: ArticleVersionStatus | null, event: ArticleVersionEvent): void {
  const result = transitionArticleVersion(from, event);
  if (!result.ok) {
    throw new Error(`article: transition ${String(from)} ${event} is ${result.reason}`);
  }
}

interface DraftInput {
  readonly title: string;
  readonly body: string;
  readonly notice_closable?: boolean;
  readonly notice_end_at?: string | null;
}

/** A contract date-time as an instant, built from the Clock's value (no `new Date` here). */
export function instantOf(now: Date, text: string): Date {
  const result = structuredClone(now);
  result.setTime(Date.parse(text));
  return result;
}

/** 9.2#8: notice fields kept for notices only; others store true / null. */
function saveInput(category: ArticleCategory, input: DraftInput, now: Date): ArticleSaveInput {
  const notice = category === 'notice';
  const end = notice ? (input.notice_end_at ?? null) : null;
  return {
    category,
    title: input.title,
    body: input.body,
    notice_closable: notice ? (input.notice_closable ?? true) : true,
    notice_end_at: end === null ? null : instantOf(now, end),
  };
}

export class ArticleAdmin {
  readonly #options: ArticleAdminOptions;

  constructor(options: ArticleAdminOptions) {
    this.#options = options;
  }

  async list(appId: string, query: ArticleAdminQuery): Promise<Schema<'AdminArticleList'>> {
    const page = Number(query.page ?? 1);
    const pageSize = Number(query.page_size ?? 20);
    const { items, total } = await this.#options.store.list({
      appId,
      now: this.#options.clock.now(),
      category: query.category,
      status: query.status,
      offset: (page - 1) * pageSize,
      limit: pageSize,
    });
    return { items, page, page_size: pageSize, total };
  }

  async detail(appId: string, articleId: string): Promise<Schema<'AdminArticle'>> {
    if (!isArticleId(articleId)) throw new ArticleNotFoundError();
    const rows = await this.#options.store.rows(appId, articleId);
    return articleView(rows, this.#options.clock.now());
  }

  async create(
    actor: ArticleAdminActor,
    input: Schema<'AdminArticleCreateRequest'>,
  ): Promise<Schema<'AdminArticle'>> {
    if (!isNewArticleId(input.article_id)) throw new ArticleFieldsError(['article_id']);
    if (input.category === 'agreement') throw new ArticleFieldsError(['category']);
    return this.#write((tx) => this.#create(tx, actor, input));
  }

  async save(
    actor: ArticleAdminActor,
    articleId: string,
    input: Schema<'AdminArticleDraftRequest'>,
  ): Promise<Schema<'AdminArticle'>> {
    if (!isArticleId(articleId)) throw new ArticleNotFoundError();
    return this.#write((tx) => this.#save(tx, actor, articleId, input));
  }

  async publish(
    actor: ArticleAdminActor,
    articleId: string,
    input: Schema<'AdminArticlePublishRequest'>,
  ): Promise<Schema<'AdminArticle'>> {
    if (!isArticleId(articleId)) throw new ArticleNotFoundError();
    return this.#write((tx) => this.#publish(tx, actor, articleId, input));
  }

  async offline(
    actor: ArticleAdminActor,
    articleId: string,
    input: Schema<'AdminArticleOfflineRequest'>,
  ): Promise<Schema<'AdminArticle'>> {
    if (!isArticleId(articleId)) throw new ArticleNotFoundError();
    return this.#write((tx) => this.#offline(tx, actor, articleId, input));
  }

  async #write<T>(work: (tx: ArticleAdminTx) => Promise<T>): Promise<T> {
    try {
      return await this.#options.store.transaction(work);
    } catch (error) {
      // Mapped after the transaction ended: PG has rolled the whole write back (L41 / L48).
      if (this.#options.isVersionTaken(error)) throw new ArticleConflictError();
      throw error;
    }
  }

  /** Save checks (20001): 9.2#7 context read inside the transaction. */
  async #check(
    tx: ArticleAdminTx,
    appId: string,
    articleId: string,
    input: ArticleSaveInput,
  ): Promise<void> {
    const words = this.#options.bannedWords();
    const needsHelpLinks = words.some((word) =>
      (word.allow_articles ?? []).some((rule) => rule.config_key.startsWith(HELP_LINKS_PREFIX)),
    );
    const helpLinks = needsHelpLinks ? await tx.configValue(appId, HELP_LINKS) : undefined;
    const result = validateArticleSave(input, {
      mediaHosts: mediaHostsOf(this.#options.mediaPublicBaseUrl),
      // Missing or any value other than boolean false keeps the block on (F1-02w followups).
      unionHostBlock: (await tx.configValue(appId, UNION_HOST_BLOCK)) !== false,
      linkPatterns: this.#options.linkPatterns(),
      bannedWords: words,
      articleConfigKeys: articleConfigKeysFor(articleId, words, helpLinks),
    });
    if (!result.ok) throw new ArticleFieldsError(articleFieldList(result.fields, result.paths));
  }

  /** 30701 → lock → [category]; returns the app's rows of the id, newest first. */
  async #locked(tx: ArticleAdminTx, appId: string, articleId: string): Promise<ArticleRow[]> {
    if (!(await tx.lock(appId, articleId))) throw new ArticleNotFoundError();
    const rows = [...(await tx.rows(appId, articleId))];
    const newest = rows[0];
    if (newest === undefined) throw new ArticleNotFoundError();
    if (newest.category === 'agreement') throw new ArticleFieldsError(['category']);
    return rows;
  }

  async #view(tx: ArticleAdminTx, appId: string, articleId: string, now: Date) {
    return articleView(await tx.rows(appId, articleId), now);
  }

  async #create(
    tx: ArticleAdminTx,
    actor: ArticleAdminActor,
    input: Schema<'AdminArticleCreateRequest'>,
  ): Promise<Schema<'AdminArticle'>> {
    const { appId } = actor;
    const id = input.article_id;
    const now = this.#options.clock.now();
    const fields = saveInput(input.category, input, now);
    await this.#check(tx, appId, id, fields);
    if (await tx.taken(id)) throw new ArticleConflictError();
    transition(null, 'DRAFT_SAVED');
    const row: ArticleRow = {
      id,
      app_id: appId,
      ...fields,
      version: 1,
      status: 'draft',
      published_at: null,
      notice_content_version: nextNoticeContentVersion(null, fields),
      row_version: 0,
      created_at: now,
      updated_at: now,
    };
    await tx.insert(row);
    await tx.audit({
      appId,
      actor: actor.adminId,
      action: 'article_create',
      target: id,
      before: null,
      after: { ...facts(row), category: row.category },
      ip: actor.ip,
    });
    return this.#view(tx, appId, id, now);
  }

  async #save(
    tx: ArticleAdminTx,
    actor: ArticleAdminActor,
    articleId: string,
    input: Schema<'AdminArticleDraftRequest'>,
  ): Promise<Schema<'AdminArticle'>> {
    const { appId } = actor;
    const rows = await this.#locked(tx, appId, articleId);
    const newest = rows[0]!;
    const now = this.#options.clock.now();
    const fields = saveInput(newest.category, input, now);
    // L49: save checks before the CAS.
    await this.#check(tx, appId, articleId, fields);
    if (input.expected_row_version !== newest.row_version) throw new ArticleConflictError();
    transition(null, 'DRAFT_SAVED');
    const row: ArticleRow = {
      id: articleId,
      app_id: appId,
      ...fields,
      version: newest.version + 1,
      status: 'draft',
      published_at: null,
      notice_content_version:
        newest.category === 'notice' ? nextNoticeContentVersion(newest, fields) : 1,
      row_version: newest.row_version + 1,
      created_at: now,
      updated_at: now,
    };
    await tx.insert(row);
    await tx.audit({
      appId,
      actor: actor.adminId,
      action: 'article_draft_save',
      target: articleId,
      before: facts(newest),
      after: facts(row),
      ip: actor.ip,
    });
    return this.#view(tx, appId, articleId, now);
  }

  async #publish(
    tx: ArticleAdminTx,
    actor: ArticleAdminActor,
    articleId: string,
    input: Schema<'AdminArticlePublishRequest'>,
  ): Promise<Schema<'AdminArticle'>> {
    const { appId } = actor;
    const rows = await this.#locked(tx, appId, articleId);
    const newest = rows[0]!;
    // L49: CAS before the state checks, so a retry of a publish that took effect gets 20902.
    if (input.expected_row_version !== newest.row_version) throw new ArticleConflictError();
    if (input.version !== newest.version || newest.status !== 'draft') {
      throw new ArticleFieldsError(['version']);
    }
    const now = this.#options.clock.now();
    const at = input.published_at === undefined ? now : instantOf(now, input.published_at);
    if (at.getTime() < now.getTime()) throw new ArticleFieldsError(['published_at']);
    await this.#check(tx, appId, articleId, newest);
    transition(newest.status, 'PUBLISH');
    const updated = await tx.update(appId, articleId, newest.version, newest.row_version, {
      status: 'published',
      published_at: at,
      row_version: newest.row_version + 1,
      updated_at: now,
    });
    if (!updated) throw new ArticleConflictError();
    await tx.audit({
      appId,
      actor: actor.adminId,
      action: 'article_publish',
      target: articleId,
      before: facts(newest),
      after: {
        version: newest.version,
        status: 'published',
        row_version: newest.row_version + 1,
        published_at: at.toISOString(),
      },
      ip: actor.ip,
    });
    return this.#view(tx, appId, articleId, now);
  }

  async #offline(
    tx: ArticleAdminTx,
    actor: ArticleAdminActor,
    articleId: string,
    input: Schema<'AdminArticleOfflineRequest'>,
  ): Promise<Schema<'AdminArticle'>> {
    const { appId } = actor;
    const rows = await this.#locked(tx, appId, articleId);
    const newest = rows[0]!;
    if (input.expected_row_version !== newest.row_version) throw new ArticleConflictError();
    const published = rows.filter((row) => row.status === 'published');
    if (published.length === 0) throw new ArticleFieldsError(['article_id']);
    const now = this.#options.clock.now();
    const notice = newest.category === 'notice';
    const before: Facts[] = [];
    const after: Facts[] = [];
    for (const row of published) {
      transition(row.status, 'OFFLINE');
      // 9.2#6: a notice's window closes now unless it already ended earlier.
      const closes =
        notice && (row.notice_end_at === null || row.notice_end_at.getTime() > now.getTime());
      const isNewest = row.version === newest.version;
      const updated = await tx.update(appId, articleId, row.version, row.row_version, {
        status: 'offline',
        ...(closes ? { notice_end_at: now } : {}),
        ...(isNewest ? { row_version: row.row_version + 1 } : {}),
        updated_at: now,
      });
      if (!updated) throw new ArticleConflictError();
      before.push({ ...facts(row), notice_end_at: iso(row.notice_end_at) });
      after.push({
        ...facts(row),
        status: 'offline',
        row_version: isNewest ? row.row_version + 1 : row.row_version,
        notice_end_at: closes ? now.toISOString() : iso(row.notice_end_at),
      });
    }
    if (newest.status !== 'published') {
      const updated = await tx.update(appId, articleId, newest.version, newest.row_version, {
        row_version: newest.row_version + 1,
        updated_at: now,
      });
      if (!updated) throw new ArticleConflictError();
    }
    await tx.audit({
      appId,
      actor: actor.adminId,
      action: 'article_offline',
      target: articleId,
      before: { row_version: newest.row_version, versions: before },
      after: { row_version: newest.row_version + 1, versions: after },
      ip: actor.ip,
    });
    return this.#view(tx, appId, articleId, now);
  }
}
