// F1-02p: the console's agreement versions (/admin/v1/agreements*; contract adminListAgreements,
// adminGetAgreementVersion, adminPublishAgreementVersion; 04 §6.6 agreements, §10.1 legal.*,
// BR-ID-12, OPS-14; 编排者裁定 F1-02p 1–11, decisions L1–L4 / L24 / L26 / L27 / L34 / L42–L44).
// Reads: published versions newest first (published_at, then version), one version with the title
// and body of its article. Publish (one transaction, any refusal throws so it all rolls back):
// advisory lock on (app, type) → current version and CAS (20902, resource agreement) → checks
// (validateAgreementPublish + validateArticleSave without banned words, 20001) → H5 url (50001
// when h5_base_url is missing or not https) → article row (category agreement, published, no state
// machine) → agreements row → legal.<type>.* config with history (never backwards, 50001) →
// audit. Versions are never changed or deleted (L2). The app and admin come from the guard's actor.
import type { Schema } from '@couli/contracts-ts';
import type { Logger } from 'pino';
import type { AuditInput, Clock, LinkPatternsSpec } from '../../platform/index.ts';
import { agreementTextUrl } from '../domain/agreements/text-url.ts';
import { validateAgreementPublish, type AgreementType } from '../domain/agreements/index.ts';
import { textSha256 } from '../domain/article-body/index.ts';
import { validateArticleSave } from '../domain/articles-admin/index.ts';

export type AgreementView = Schema<'AdminAgreementVersion'>;
export type AgreementDetailView = Schema<'AdminAgreementVersionDetail'>;
export type AgreementPublishBody = Schema<'AdminAgreementPublishRequest'>;

export interface AgreementActor {
  readonly appId: string;
  readonly adminId: string;
  readonly loginName: string;
  readonly ip: string | null;
}

export interface AgreementListQuery {
  readonly type?: AgreementType;
  readonly page?: number;
  readonly page_size?: number;
}

/** The type's newest agreements row as read inside the publish transaction. */
export interface CurrentAgreementVersion {
  readonly version: number;
  readonly min_version: number;
  readonly requires_resign: boolean;
  readonly article_id: string;
}

/** One stored revision of an article id (any app: the caller checks ownership). */
export interface ArticleRevision {
  readonly app_id: string;
  readonly version: number;
  readonly row_version: number;
}

export interface ConfigRow {
  readonly value: unknown;
  readonly version: number;
}

export interface AgreementReads {
  list(
    appId: string,
    type: AgreementType | undefined,
    offset: number,
    limit: number,
  ): Promise<{ items: AgreementView[]; total: number }>;
  detail(
    appId: string,
    type: AgreementType,
    version: number,
  ): Promise<AgreementDetailView | undefined>;
}

export interface NewArticleRow {
  readonly id: string;
  readonly appId: string;
  readonly version: number;
  readonly rowVersion: number;
  readonly title: string;
  readonly body: string;
  readonly at: Date;
}

export interface NewAgreementRow {
  readonly id: string;
  readonly appId: string;
  readonly type: AgreementType;
  readonly version: number;
  readonly minVersion: number;
  readonly requiresResign: boolean;
  readonly articleId: string;
  readonly articleVersion: number;
  readonly textSha256: string;
  readonly url: string;
  readonly legalConfirmedBy: string;
  readonly legalConfirmNote: string;
  readonly publishedBy: string;
  readonly at: Date;
}

export interface LegalConfigWrite {
  readonly appId: string;
  readonly key: string;
  readonly value: number;
  /** The row as locked, undefined = no row yet (inserted at version 1). */
  readonly existing: ConfigRow | undefined;
  readonly adminId: string;
  readonly loginName: string;
  readonly at: Date;
}

export interface AgreementTx {
  /** pg_advisory_xact_lock on (app, type): serialises publishes of one type, first one included. */
  lock(appId: string, type: AgreementType): Promise<void>;
  current(appId: string, type: AgreementType): Promise<CurrentAgreementVersion | undefined>;
  /** Raw config_items value read inside the transaction (undefined = no row), never cached. */
  configValue(appId: string, key: string): Promise<unknown>;
  /** config_items row FOR UPDATE (undefined = no row). */
  lockConfig(appId: string, key: string): Promise<ConfigRow | undefined>;
  /** Every stored revision of the article id, newest (largest version) first, any app. */
  articleRevisions(articleId: string): Promise<readonly ArticleRevision[]>;
  insertArticle(row: NewArticleRow): Promise<void>;
  insertAgreement(row: NewAgreementRow): Promise<void>;
  /** Insert (version 1) or bump version / row_version by 1; returns the new version. */
  writeConfig(input: LegalConfigWrite): Promise<number>;
  /** One config_item_versions row (reason agreement_publish). */
  history(input: LegalConfigWrite, version: number): Promise<void>;
  audit(input: AuditInput): Promise<void>;
}

export interface AgreementStore extends AgreementReads {
  transaction<T>(work: (tx: AgreementTx) => Promise<T>): Promise<T>;
}

export interface AgreementAdminOptions {
  readonly store: AgreementStore;
  readonly clock: Clock;
  readonly logger: Logger;
  /** MEDIA_PUBLIC_BASE_URL as configured (L27); undefined admits no image host. */
  readonly mediaPublicBaseUrl: string | undefined;
  readonly linkPatterns: () => LinkPatternsSpec;
  readonly newId: (now: Date) => string;
  /** True for a unique violation of the (app_id, type, version) key: a concurrent publish. */
  readonly isVersionTaken: (error: unknown) => boolean;
}

export class AgreementFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`agreement: invalid ${fields.join(', ')}`);
    this.name = 'AgreementFieldsError';
    this.fields = fields;
  }
}

export class AgreementConflictError extends Error {
  constructor() {
    super('agreement: version conflict');
    this.name = 'AgreementConflictError';
  }
}

export class AgreementNotFoundError extends Error {
  constructor() {
    super('agreement: no such version');
    this.name = 'AgreementNotFoundError';
  }
}

const UNION_HOST_BLOCK = 'external_page.union_host_block';
const H5_BASE_URL = 'h5_base_url';

/** L24: the config keys a published version of the type moves (labor_agreement has none). */
export function legalKeysOf(
  type: AgreementType,
): readonly { readonly key: string; readonly field: 'version' | 'min_version' }[] {
  if (type === 'privacy') {
    return [
      { key: 'legal.privacy.version', field: 'version' },
      { key: 'legal.privacy.min_version', field: 'min_version' },
    ];
  }
  if (type === 'agreement') return [{ key: 'legal.agreement.version', field: 'version' }];
  return [];
}

/** Host of MEDIA_PUBLIC_BASE_URL, [] when absent or unparsable (L27). */
export function mediaHostsOf(base: string | undefined): string[] {
  if (base === undefined) return [];
  try {
    const host = new URL(base).hostname;
    return host === '' ? [] : [host];
  } catch {
    return [];
  }
}

/** L37: field names (deduplicated, first occurrence kept) before body paths. */
export function mergeFields(
  names: readonly (readonly string[])[],
  paths: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const field of names.flat()) {
    if (seen.has(field)) continue;
    seen.add(field);
    out.push(field);
  }
  return [...out, ...paths];
}

function bounds(query: AgreementListQuery | undefined): { page: number; pageSize: number } {
  return { page: Number(query?.page ?? 1), pageSize: Number(query?.page_size ?? 20) };
}

export class AgreementAdmin {
  readonly #options: AgreementAdminOptions;

  constructor(options: AgreementAdminOptions) {
    this.#options = options;
  }

  async list(
    appId: string,
    query?: AgreementListQuery,
  ): Promise<Schema<'AdminAgreementVersionList'>> {
    const { page, pageSize } = bounds(query);
    const { items, total } = await this.#options.store.list(
      appId,
      query?.type,
      (page - 1) * pageSize,
      pageSize,
    );
    return { items, page, page_size: pageSize, total };
  }

  async detail(appId: string, type: AgreementType, version: number): Promise<AgreementDetailView> {
    const view = await this.#options.store.detail(appId, type, version);
    if (view === undefined) throw new AgreementNotFoundError();
    return view;
  }

  async publish(
    actor: AgreementActor,
    type: AgreementType,
    body: AgreementPublishBody,
  ): Promise<AgreementView> {
    try {
      return await this.#options.store.transaction((tx) => this.#publish(tx, actor, type, body));
    } catch (error) {
      // Mapped after the transaction ended: PG has rolled the whole publish back (§9.2#2).
      if (this.#options.isVersionTaken(error)) throw new AgreementConflictError();
      throw error;
    }
  }

  async #publish(
    tx: AgreementTx,
    actor: AgreementActor,
    type: AgreementType,
    body: AgreementPublishBody,
  ): Promise<AgreementView> {
    const { appId } = actor;
    await tx.lock(appId, type);
    const current = await tx.current(appId, type);
    if (body.expected_version !== (current?.version ?? 0)) throw new AgreementConflictError();
    const version = (current?.version ?? 0) + 1;

    // Checks (20001). Agreements skip the banned-word scan (L42); links and images as articles.
    const agreement = validateAgreementPublish(
      {
        type,
        version,
        min_version: body.min_version,
        requires_resign: body.requires_resign,
        legal_confirmed_by: body.legal_confirmed_by,
        legal_confirm_note: body.legal_confirm_note,
        legal_confirmed_on: body.legal_confirmed_on,
      },
      current ?? null,
    );
    const article = validateArticleSave(
      {
        category: 'agreement',
        title: body.title,
        body: body.body,
        notice_closable: false,
        notice_end_at: null,
      },
      {
        mediaHosts: mediaHostsOf(this.#options.mediaPublicBaseUrl),
        // Missing or any value other than boolean false keeps the block on (F1-02c 裁定 8).
        unionHostBlock: (await tx.configValue(appId, UNION_HOST_BLOCK)) !== false,
        linkPatterns: this.#options.linkPatterns(),
        bannedWords: [],
        articleConfigKeys: [],
      },
    );
    if (!agreement.ok || !article.ok) {
      throw new AgreementFieldsError(
        mergeFields(
          [agreement.ok ? [] : agreement.fields, article.ok ? [] : article.fields],
          article.ok ? [] : article.paths,
        ),
      );
    }

    // L43: the stored url; a missing or non-https H5 base is a configuration fault (50001).
    const base = await tx.configValue(appId, H5_BASE_URL);
    const url = typeof base === 'string' ? agreementTextUrl(base, type, version) : null;
    if (url === null) {
      this.#options.logger.error(
        { app_id: appId, agreement_type: type, key: H5_BASE_URL },
        'agreement_publish_h5_base_url_invalid',
      );
      throw new Error('agreement: h5_base_url missing or not https');
    }

    // L44: a legal.<type>.version already at or past the new version is never overwritten.
    const keys = legalKeysOf(type);
    const locked = new Map<string, ConfigRow | undefined>();
    for (const { key, field } of keys) {
      const row = await tx.lockConfig(appId, key);
      locked.set(key, row);
      if (
        field === 'version' &&
        row !== undefined &&
        typeof row.value === 'number' &&
        Number.isInteger(row.value) &&
        row.value >= version
      ) {
        this.#options.logger.error(
          { app_id: appId, agreement_type: type, key, config_value: row.value, version },
          'agreement_publish_legal_version_ahead',
        );
        throw new Error(`agreement: ${key} is already ${String(row.value)}`);
      }
    }

    // L1 / L34: the text is a new revision of the type's agreement article (first: a new id).
    const at = this.#options.clock.now();
    const articleId = current?.article_id ?? this.#options.newId(at);
    const revisions = current === undefined ? [] : await tx.articleRevisions(articleId);
    // §9.12 ③: the foreign keys do not include app_id; another app's article fails closed.
    if (current !== undefined && revisions.length === 0) {
      throw new Error('agreement: the current version has no article');
    }
    if (revisions.some((row) => row.app_id !== appId)) {
      this.#options.logger.error(
        { app_id: appId, agreement_type: type, article_id: articleId },
        'agreement_publish_article_app_mismatch',
      );
      throw new Error('agreement: the agreement article belongs to another app');
    }
    const latest = revisions.reduce<ArticleRevision | undefined>(
      (best, row) => (best === undefined || row.version > best.version ? row : best),
      undefined,
    );
    const articleVersion = (latest?.version ?? 0) + 1;
    await tx.insertArticle({
      id: articleId,
      appId,
      version: articleVersion,
      rowVersion: latest === undefined ? 0 : latest.row_version + 1,
      title: body.title,
      body: body.body,
      at,
    });

    const sha = textSha256(body.body);
    await tx.insertAgreement({
      id: this.#options.newId(at),
      appId,
      type,
      version,
      minVersion: body.min_version,
      requiresResign: body.requires_resign,
      articleId,
      articleVersion,
      textSha256: sha,
      url,
      legalConfirmedBy: body.legal_confirmed_by,
      legalConfirmNote: body.legal_confirm_note,
      publishedBy: actor.adminId,
      at,
    });

    for (const { key, field } of keys) {
      const write: LegalConfigWrite = {
        appId,
        key,
        value: field === 'version' ? version : body.min_version,
        existing: locked.get(key),
        adminId: actor.adminId,
        loginName: actor.loginName,
        at,
      };
      await tx.history(write, await tx.writeConfig(write));
    }

    // BR-ID-12: confirmer and date in the audit row; the text stays in the article row.
    await tx.audit({
      appId,
      actor: actor.adminId,
      action: 'agreement_publish',
      target: `${type}:${String(version)}`,
      before:
        current === undefined
          ? null
          : {
              version: current.version,
              min_version: current.min_version,
              requires_resign: current.requires_resign,
            },
      after: {
        type,
        version,
        min_version: body.min_version,
        requires_resign: body.requires_resign,
        article_id: articleId,
        article_version: articleVersion,
        text_sha256: sha,
        legal_confirmed_by: body.legal_confirmed_by,
        legal_confirmed_on: body.legal_confirmed_on,
      },
      ip: actor.ip,
    });

    return {
      type,
      version,
      min_version: body.min_version,
      requires_resign: body.requires_resign,
      article_id: articleId,
      article_version: articleVersion,
      text_sha256: sha,
      url,
      legal_confirmed_by: body.legal_confirmed_by,
      legal_confirm_note: body.legal_confirm_note,
      published_at: at.toISOString(),
      published_by: actor.adminId,
    };
  }
}
