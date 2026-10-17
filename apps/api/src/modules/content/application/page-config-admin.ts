// F1-09f: the console's page configuration (/admin/v1/pages*; contract adminListPageConfigs …
// adminRollbackPageConfig; 04 §6.6 `pages`, §3.2; 编排者裁定 F1-09f 1–10, F1–F6).
// Reads: pages with at least one saved version, their version history, one version with sections.
// Writes (one transaction each): lock the page row FOR UPDATE (a draft save first creates it at
// revision 0), then 30701 (no saved version; draft saves excepted) → 20902 (revision ≠
// expected_revision, data.resource=page) → 20001 (state / sections); on success the page row's
// revision goes up by 1 and one audit row is appended in the same transaction. Any refusal throws,
// so the transaction rolls back, a first save's new row included.
// Saved sections are never changed; publish re-runs the save checks on the stored sections, with
// switch external_page.union_host_block read inside the transaction (not cached, F4).
// Permission checks are the controller's guard; app and admin come from the guard's actor.
import type { Schema } from '@couli/contracts-ts';
import type { AuditInput, Clock } from '../../platform/index.ts';

export type PageView = Schema<'AdminPageConfig'>;
export type PageVersionView = Schema<'AdminPageConfigVersion'>;
export type PageVersionSummary = Schema<'AdminPageConfigVersionSummary'>;

export interface PageRow {
  readonly currentVersion: number | null;
  readonly grayVersion: number | null;
  readonly grayPercent: number;
  readonly revision: number;
}

export interface PageVersionRow {
  readonly version: number;
  readonly status: string;
  readonly sections: unknown;
}

export interface PageActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

export interface PageListQuery {
  readonly page?: number;
  readonly page_size?: number;
}

export interface PagePointers {
  readonly currentVersion: number | null;
  readonly grayVersion: number | null;
  readonly grayPercent: number;
}

/** Reads with the login names of the admins joined in (P5); all scoped to one app. */
export interface PageConfigReads {
  pages(
    appId: string,
    offset: number,
    limit: number,
  ): Promise<{ items: PageView[]; total: number }>;
  /** undefined when the page has no saved version (an empty lock row included). */
  page(appId: string, key: string): Promise<PageView | undefined>;
  versions(
    appId: string,
    key: string,
    offset: number,
    limit: number,
  ): Promise<{ items: PageVersionSummary[]; total: number }>;
  version(appId: string, key: string, version: number): Promise<PageVersionView | undefined>;
}

export interface PageConfigTx extends PageConfigReads {
  /** Raw value of config_items external_page.union_host_block (undefined = no row), unbuffered. */
  unionHostBlock(appId: string): Promise<unknown>;
  /** INSERT … ON CONFLICT DO NOTHING of a revision-0 page row. */
  ensurePage(appId: string, key: string, at: Date): Promise<void>;
  lock(appId: string, key: string): Promise<PageRow | undefined>;
  latestVersion(appId: string, key: string): Promise<number | null>;
  versionRow(appId: string, key: string, version: number): Promise<PageVersionRow | undefined>;
  insertVersion(input: {
    appId: string;
    key: string;
    version: number;
    sections: unknown;
    adminId: string;
    at: Date;
  }): Promise<void>;
  markPublished(
    appId: string,
    key: string,
    version: number,
    publisher: string,
    at: Date,
  ): Promise<void>;
  markRolledBack(appId: string, key: string, version: number): Promise<void>;
  /** Published versions other than `except`, newest publish_at first, ties by higher version. */
  successor(appId: string, key: string, except: number): Promise<number | undefined>;
  /** One UPDATE of the three pointers, revision + 1, updated_by_admin_id and updated_at. */
  updatePage(
    appId: string,
    key: string,
    pointers: PagePointers,
    revision: number,
    adminId: string,
    at: Date,
  ): Promise<void>;
  audit(input: AuditInput): Promise<void>;
}

export interface PageConfigStore extends PageConfigReads {
  transaction<T>(work: (tx: PageConfigTx) => Promise<T>): Promise<T>;
}

/** Save / publish checks of a page's sections (home-schema shape + F1-09c), [] when valid. */
export type PageSectionsCheck = (sections: unknown, unionHostBlock: boolean) => readonly string[];

export class PageFieldsError extends Error {
  readonly fields: readonly string[];

  constructor(fields: readonly string[]) {
    super(`page config: invalid ${fields.join(', ')}`);
    this.name = 'PageFieldsError';
    this.fields = fields;
  }
}

export class PageConflictError extends Error {
  constructor() {
    super('page config: revision conflict');
    this.name = 'PageConflictError';
  }
}

export class PageNotFoundError extends Error {
  constructor() {
    super('page config: no saved version');
    this.name = 'PageNotFoundError';
  }
}

type WriteAction = 'page_version_create' | 'page_publish' | 'page_gray_update' | 'page_rollback';

function bounds(query: PageListQuery | undefined): { page: number; pageSize: number } {
  return { page: query?.page ?? 1, pageSize: query?.page_size ?? 20 };
}

function stateOf(key: string, row: PageRow | (PagePointers & { revision: number })) {
  return {
    page_key: key,
    revision: row.revision,
    current_version: row.currentVersion,
    gray_version: row.grayVersion,
    gray_percent: row.grayPercent,
  };
}

export class PageConfigAdmin {
  readonly #store: PageConfigStore;
  readonly #clock: Clock;
  readonly #check: PageSectionsCheck;

  constructor(store: PageConfigStore, clock: Clock, check: PageSectionsCheck) {
    this.#store = store;
    this.#clock = clock;
    this.#check = check;
  }

  async list(appId: string, query?: PageListQuery): Promise<Schema<'AdminPageConfigList'>> {
    const { page, pageSize } = bounds(query);
    const { items, total } = await this.#store.pages(appId, (page - 1) * pageSize, pageSize);
    return { items, page, page_size: pageSize, total };
  }

  async page(appId: string, key: string): Promise<PageView> {
    const view = await this.#store.page(appId, key);
    if (view === undefined) throw new PageNotFoundError();
    return view;
  }

  async versions(
    appId: string,
    key: string,
    query?: PageListQuery,
  ): Promise<Schema<'AdminPageConfigVersionList'>> {
    const { page, pageSize } = bounds(query);
    // A page with no saved version is 30701, not an empty history.
    if ((await this.#store.page(appId, key)) === undefined) throw new PageNotFoundError();
    const { items, total } = await this.#store.versions(
      appId,
      key,
      (page - 1) * pageSize,
      pageSize,
    );
    return { items, page, page_size: pageSize, total };
  }

  async version(appId: string, key: string, version: number): Promise<PageVersionView> {
    const view = await this.#store.version(appId, key, version);
    if (view === undefined) throw new PageNotFoundError();
    return view;
  }

  /** adminCreatePageConfigVersion: a new draft numbered newest + 1; the first save makes the page. */
  async save(
    actor: PageActor,
    key: string,
    body: Schema<'AdminPageConfigDraftRequest'>,
  ): Promise<PageVersionView> {
    return this.#store.transaction(async (tx) => {
      // Sections depend only on the request: checked before the page row is touched (F1).
      this.#validate(body.sections, await tx.unionHostBlock(actor.appId));
      const at = this.#clock.now();
      await tx.ensurePage(actor.appId, key, at);
      const row = await tx.lock(actor.appId, key);
      if (row === undefined) throw new Error('content: page row missing after ensurePage');
      if (row.revision !== body.expected_revision) throw new PageConflictError();
      const version = ((await tx.latestVersion(actor.appId, key)) ?? 0) + 1;
      await tx.insertVersion({
        appId: actor.appId,
        key,
        version,
        sections: body.sections,
        adminId: actor.adminId,
        at,
      });
      await this.#finish(tx, actor, key, row, row, version, at, 'page_version_create');
      const view = await tx.version(actor.appId, key, version);
      if (view === undefined) throw new Error('content: saved page version not readable');
      return view;
    });
  }

  /** adminPublishPageConfig: 100 = fully released (the previous one stays published), 1..99 gray. */
  async publish(
    actor: PageActor,
    key: string,
    body: Schema<'AdminPageConfigPublishRequest'>,
  ): Promise<PageView> {
    return this.#write(actor, key, body.expected_revision, async (tx, row) => {
      const target = await tx.versionRow(actor.appId, key, body.version);
      if (target === undefined || target.status !== 'draft') throw new PageFieldsError(['version']);
      if (row.grayVersion !== null) throw new PageFieldsError(['version']);
      if (row.currentVersion === null && body.gray_percent !== 100) {
        throw new PageFieldsError(['gray_percent']);
      }
      this.#validate(target.sections, await tx.unionHostBlock(actor.appId));
      const at = this.#clock.now();
      await tx.markPublished(actor.appId, key, body.version, actor.adminId, at);
      const pointers: PagePointers =
        body.gray_percent === 100
          ? { currentVersion: body.version, grayVersion: null, grayPercent: 0 }
          : {
              currentVersion: row.currentVersion,
              grayVersion: body.version,
              grayPercent: body.gray_percent,
            };
      return { pointers, version: body.version, at, action: 'page_publish' };
    });
  }

  /** adminUpdatePageConfigGray: 1..99 changes the share, 100 releases the gray version fully. */
  async gray(
    actor: PageActor,
    key: string,
    body: Schema<'AdminPageConfigGrayRequest'>,
  ): Promise<PageView> {
    return this.#write(actor, key, body.expected_revision, async (_tx, row) => {
      const gray = row.grayVersion;
      if (gray === null) throw new PageFieldsError(['gray_percent']);
      // Releasing fully keeps the version's publish_at / publisher (F2).
      const pointers: PagePointers =
        body.gray_percent === 100
          ? { currentVersion: gray, grayVersion: null, grayPercent: 0 }
          : {
              currentVersion: row.currentVersion,
              grayVersion: gray,
              grayPercent: body.gray_percent,
            };
      return { pointers, version: gray, at: this.#clock.now(), action: 'page_gray_update' };
    });
  }

  /**
   * adminRollbackPageConfig: the gray version, or (without one) the fully released version, which
   * falls back to the other published version with the latest publish_at, ties by higher number.
   */
  async rollback(
    actor: PageActor,
    key: string,
    body: Schema<'AdminPageConfigRollbackRequest'>,
  ): Promise<PageView> {
    return this.#write(actor, key, body.expected_revision, async (tx, row) => {
      let pointers: PagePointers;
      if (row.grayVersion !== null && body.version === row.grayVersion) {
        pointers = { currentVersion: row.currentVersion, grayVersion: null, grayPercent: 0 };
      } else if (
        row.currentVersion !== null &&
        body.version === row.currentVersion &&
        row.grayVersion === null
      ) {
        const next = await tx.successor(actor.appId, key, body.version);
        if (next === undefined) throw new PageFieldsError(['version']);
        pointers = { currentVersion: next, grayVersion: null, grayPercent: 0 };
      } else {
        throw new PageFieldsError(['version']);
      }
      await tx.markRolledBack(actor.appId, key, body.version);
      return { pointers, version: body.version, at: this.#clock.now(), action: 'page_rollback' };
    });
  }

  /** Publish / gray / rollback: lock, 30701, CAS, then the operation's own checks and pointers. */
  async #write(
    actor: PageActor,
    key: string,
    expectedRevision: number,
    change: (
      tx: PageConfigTx,
      row: PageRow,
    ) => Promise<{ pointers: PagePointers; version: number; at: Date; action: WriteAction }>,
  ): Promise<PageView> {
    return this.#store.transaction(async (tx) => {
      const row = await tx.lock(actor.appId, key);
      if (row === undefined || (await tx.latestVersion(actor.appId, key)) === null) {
        throw new PageNotFoundError();
      }
      if (row.revision !== expectedRevision) throw new PageConflictError();
      const result = await change(tx, row);
      await this.#finish(
        tx,
        actor,
        key,
        row,
        result.pointers,
        result.version,
        result.at,
        result.action,
      );
      const view = await tx.page(actor.appId, key);
      if (view === undefined) throw new Error('content: written page not readable');
      return view;
    });
  }

  async #finish(
    tx: PageConfigTx,
    actor: PageActor,
    key: string,
    before: PageRow,
    pointers: PagePointers,
    version: number,
    at: Date,
    action: WriteAction,
  ): Promise<void> {
    const revision = before.revision + 1;
    await tx.updatePage(actor.appId, key, pointers, revision, actor.adminId, at);
    // Sections stay out of the audit row (the version table keeps them).
    await tx.audit({
      appId: actor.appId,
      actor: actor.adminId,
      action,
      target: key,
      before: { ...stateOf(key, before), version },
      after: { ...stateOf(key, { ...pointers, revision }), version },
      ip: actor.ip,
    });
  }

  #validate(sections: unknown, switchValue: unknown): void {
    // Missing or any value other than boolean false keeps the block on (F1-02c 裁定 8 口径).
    const fields = this.#check(sections, switchValue !== false);
    if (fields.length > 0) throw new PageFieldsError(fields);
  }
}
