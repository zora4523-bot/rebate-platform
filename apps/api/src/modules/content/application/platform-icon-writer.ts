// Admin writes of the platform mark replacement images (F1-06y; contract
// adminUpdatePlatformIconVersion, adminPublishPlatformIcon, adminRestoreBuiltinPlatformIcon;
// 08 BR-TEXT-24 细则「必填登记」「发布与回滚」; 04 §6.6 CAS, §11 every admin write is audited;
// orchestrator rulings F1-06n 7, 8, 11). The permission point content.platform_icon is checked
// by the controller through platform's AdminOperationGuard before any call here; appId and the
// editor are the verified admin's, never request fields.
//
// Concurrency: every write runs in one transaction that first takes the mark row
// (platform_icons) — created at revision 0 when absent, then SELECT … FOR UPDATE — and only then
// touches a version row, so registrations and publishes of one mark never deadlock.
//   - registration: CAS on the version's own revision in one conditional UPDATE … RETURNING
//     (revision = expected AND ever_published = false); 0 rows → 20001 [version] when the version
//     is unknown or has been published, otherwise 20902. The mark keeps its revision; only its
//     updated_* columns move.
//   - publish / rollback / restore-builtin: CAS on the mark's revision checked under the row lock;
//     a mismatch is 20902. Publishing the current version or restoring a mark already on the
//     built-in image (with a matching revision) changes nothing: no revision bump, no audit.
//     Otherwise revision + 1, current_version written, and a published version's ever_published
//     set to true after the mark is locked.
// Any refusal throws inside the transaction, so nothing of it (not even the lock row) remains.
// The audit row is appended on the same transaction (actions version_source, publish, rollback,
// restore_builtin; facts key, from_version, to_version; never file contents).
//
// Save as version (F1-06x; adminCreatePlatformIconVersion; rulings F1-06n 2, 7, 9): one
// transaction reads the upload (a plain read: uploads are SELECT / INSERT only, never locked;
// missing, expired at expires_at <= now, another key or another app → 20001 [upload_id]), then
// takes the mark row as above, and only under that lock looks for a version already saved from
// this upload_id (found → 200 with it as it is now; nothing of the retried body is applied, no
// audit), checks sanitized_confirmed (20001 [sanitized_confirmed]), numbers the new version
// max(version) + 1 and inserts it (revision 1, never published, created_by snapshot) with
// RETURNING. The mark keeps revision and current_version; only updated_* move. Audit action
// version_create (key, version, upload_id) on the same transaction. A 23505 on the upload_id
// UNIQUE (not reachable while the lock is held, kept as the last guard) rolls back and answers
// the version that holds the upload_id.
//
// Pure module (no decorators, erasable syntax).
import type { Schema } from '@couli/contracts-ts';
import type { AuditInput, Clock } from '../../platform/index.ts';
import {
  isPlatformIconKey,
  platformIconOf,
  platformIconVersionOf,
  PlatformIconFieldsError,
  type PlatformIconRow,
  type PlatformIconVersionRow,
} from './platform-icon-reader.ts';

type Key = Schema<'PlatformIconKey'>;
type Icon = Schema<'AdminPlatformIcon'>;
type Version = Schema<'AdminPlatformIconVersion'>;

/** The verified admin making the change and the injected-clock instant of it. */
export interface PlatformIconEditor {
  readonly adminId: string;
  readonly loginName: string;
  readonly at: Date;
}

/** The trusted identity the controller passes in (from AdminOperationGuard's actor). */
export interface PlatformIconActor {
  readonly appId: string;
  readonly adminId: string;
  readonly loginName: string;
  readonly ip: string | null;
}

export interface PlatformIconMarkState {
  readonly currentVersion: number | null;
  readonly revision: number;
}

export interface PlatformIconRegistration {
  readonly hasSourceUrl: boolean;
  readonly hasDownloadedOn: boolean;
  readonly everPublished: boolean;
}

export interface PlatformIconRegistrationPatch {
  readonly sourceUrl?: string;
  /** Calendar date `YYYY-MM-DD`. */
  readonly downloadedOn?: string;
}

/** Statements of one write transaction. */
export interface PlatformIconWriteTx {
  /** Creates the mark row at revision 0 when absent, then locks it (FOR UPDATE). */
  lockMark(appId: string, key: Key): Promise<PlatformIconMarkState>;
  registration(
    appId: string,
    key: Key,
    version: number,
  ): Promise<PlatformIconRegistration | undefined>;
  /** Conditional UPDATE … RETURNING; undefined when no row matched. */
  updateRegistration(
    appId: string,
    key: Key,
    version: number,
    expectedRevision: number,
    patch: PlatformIconRegistrationPatch,
  ): Promise<PlatformIconVersionRow | undefined>;
  version(appId: string, key: Key, version: number): Promise<PlatformIconVersionRow | undefined>;
  /** revision = expected + 1 where revision = expected; false when no row matched. */
  setCurrent(
    appId: string,
    key: Key,
    expectedRevision: number,
    currentVersion: number | null,
    editor: PlatformIconEditor,
  ): Promise<boolean>;
  markPublished(appId: string, key: Key, version: number): Promise<void>;
  /** updated_by / updated_by_admin_id / updated_at only; revision unchanged. */
  touchMark(appId: string, key: Key, editor: PlatformIconEditor): Promise<void>;
  icon(
    appId: string,
    key: Key,
  ): Promise<{ row: PlatformIconRow | undefined; latestVersion: number | null }>;
  audit(input: AuditInput): Promise<void>;
  /** The platform_icon_uploads row by id (plain SELECT, no lock); undefined when absent. */
  upload(uploadId: string): Promise<PlatformIconUploadState | undefined>;
  /** The version of the mark saved from this upload, as it is now. */
  savedVersion(
    appId: string,
    key: Key,
    uploadId: string,
  ): Promise<PlatformIconVersionRow | undefined>;
  /** max(version) of the mark, 0 when it has none (call under the mark lock). */
  latestVersion(appId: string, key: Key): Promise<number>;
  /** INSERT … RETURNING of a new version. */
  insertVersion(input: PlatformIconNewVersion): Promise<PlatformIconVersionRow>;
}

/** What saving needs from an upload row. */
export interface PlatformIconUploadState {
  readonly appId: string;
  readonly key: string;
  readonly sha256: string;
  readonly format: string;
  readonly bytes: number;
  readonly sanitized: boolean;
  readonly expiresAt: Date;
}

export interface PlatformIconNewVersion {
  readonly appId: string;
  readonly key: Key;
  readonly version: number;
  readonly uploadId: string;
  readonly sha256: string;
  readonly format: string;
  readonly bytes: number;
  readonly sanitized: boolean;
  readonly sourceUrl: string | null;
  /** Calendar date `YYYY-MM-DD`. */
  readonly downloadedOn: string | null;
  readonly editor: PlatformIconEditor;
}

export interface PlatformIconWriteStore {
  transaction<T>(work: (tx: PlatformIconWriteTx) => Promise<T>): Promise<T>;
}

/** 20902 with data.resource=platform_icon; the controller maps it to the error envelope. */
export class PlatformIconConflictError extends Error {
  constructor() {
    super('platform icon write: revision moved on');
    this.name = 'PlatformIconConflictError';
  }
}

export interface PlatformIconSourceBody {
  readonly expected_revision?: unknown;
  readonly source_url?: unknown;
  readonly downloaded_on?: unknown;
}

export interface PlatformIconPublishBody {
  readonly version?: unknown;
  readonly expected_revision?: unknown;
}

export interface PlatformIconRestoreBody {
  readonly expected_revision?: unknown;
}

export interface PlatformIconCreateBody {
  readonly upload_id?: unknown;
  readonly sanitized_confirmed?: unknown;
  readonly source_url?: unknown;
  readonly downloaded_on?: unknown;
}

const UNIQUE_VIOLATION = '23505';
/** platform_icon_versions.upload_id UNIQUE: an upload is saved as at most one version. */
const UPLOAD_CONSTRAINT = 'platform_icon_versions_upload_id_key';

function isUploadConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, constraint } = error as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && constraint === UPLOAD_CONSTRAINT;
}

const optionalText = (value: unknown, field: string): string | null => {
  if (value === undefined) return null;
  if (typeof value === 'string') return value;
  throw new PlatformIconFieldsError([field]);
};

const isCount = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min;

/** A path segment (string) or an already coerced number; null when not an integer ≥ 1. */
function versionParam(value: unknown): number | null {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN;
  return isCount(number, 1) && number <= 2 ** 31 - 1 ? number : null;
}

function keyOf(key: string): Key {
  if (!isPlatformIconKey(key)) throw new PlatformIconFieldsError(['key']);
  return key;
}

const target = (key: Key) => `platform_icons:${key}`;

export class PlatformIconWriter {
  readonly #store: PlatformIconWriteStore;
  readonly #clock: Clock;
  readonly #mediaPublicBaseUrl: string | undefined;

  constructor(store: PlatformIconWriteStore, clock: Clock, mediaPublicBaseUrl: string | undefined) {
    this.#store = store;
    this.#clock = clock;
    this.#mediaPublicBaseUrl = mediaPublicBaseUrl;
  }

  /** adminUpdatePlatformIconVersion: registers source_url / downloaded_on of a draft version. */
  async register(
    actor: PlatformIconActor,
    rawKey: string,
    rawVersion: unknown,
    body: PlatformIconSourceBody,
  ): Promise<Version> {
    const key = keyOf(rawKey);
    const version = versionParam(rawVersion);
    if (version === null) throw new PlatformIconFieldsError(['version']);
    // The route schema has validated the body already; these checks only narrow the types.
    const expected = body.expected_revision;
    if (!isCount(expected, 1)) throw new PlatformIconFieldsError(['expected_revision']);
    const patch: { sourceUrl?: string; downloadedOn?: string } = {};
    if (typeof body.source_url === 'string') patch.sourceUrl = body.source_url;
    else if (body.source_url !== undefined) throw new PlatformIconFieldsError(['source_url']);
    if (typeof body.downloaded_on === 'string') patch.downloadedOn = body.downloaded_on;
    else if (body.downloaded_on !== undefined) throw new PlatformIconFieldsError(['downloaded_on']);
    if (patch.sourceUrl === undefined && patch.downloadedOn === undefined) {
      throw new PlatformIconFieldsError(['source_url', 'downloaded_on']);
    }
    const editor = this.#editor(actor);
    return this.#store.transaction(async (tx) => {
      await tx.lockMark(actor.appId, key);
      const updated = await tx.updateRegistration(actor.appId, key, version, expected, patch);
      if (updated === undefined) {
        const existing = await tx.registration(actor.appId, key, version);
        if (existing === undefined || existing.everPublished) {
          throw new PlatformIconFieldsError(['version']);
        }
        throw new PlatformIconConflictError();
      }
      await tx.touchMark(actor.appId, key, editor);
      await tx.audit({
        appId: actor.appId,
        actor: actor.adminId,
        action: 'version_source',
        target: target(key),
        before: { key, version, revision: expected },
        after: {
          key,
          version,
          revision: updated.revision,
          ...(patch.sourceUrl === undefined ? {} : { source_url: patch.sourceUrl }),
          ...(patch.downloadedOn === undefined ? {} : { downloaded_on: patch.downloadedOn }),
        },
        ip: actor.ip,
      });
      return platformIconVersionOf(updated, this.#mediaPublicBaseUrl);
    });
  }

  /** adminPublishPlatformIcon: publish, or roll back to an older version. */
  async publish(
    actor: PlatformIconActor,
    rawKey: string,
    body: PlatformIconPublishBody,
  ): Promise<Icon> {
    const key = keyOf(rawKey);
    const version = versionParam(body.version);
    if (version === null || typeof body.version !== 'number') {
      throw new PlatformIconFieldsError(['version']);
    }
    const expected = body.expected_revision;
    if (!isCount(expected, 0)) throw new PlatformIconFieldsError(['expected_revision']);
    const editor = this.#editor(actor);
    return this.#store.transaction(async (tx) => {
      const mark = await tx.lockMark(actor.appId, key);
      if (mark.revision !== expected) throw new PlatformIconConflictError();
      if (mark.currentVersion === version) return this.#icon(tx, actor.appId, key);
      const registration = await tx.registration(actor.appId, key, version);
      if (registration === undefined) throw new PlatformIconFieldsError(['version']);
      const missing = [
        ...(registration.hasSourceUrl ? [] : ['source_url']),
        ...(registration.hasDownloadedOn ? [] : ['downloaded_on']),
      ];
      if (missing.length > 0) throw new PlatformIconFieldsError(missing);
      const from = mark.currentVersion;
      if (!(await tx.setCurrent(actor.appId, key, expected, version, editor))) {
        throw new PlatformIconConflictError();
      }
      await tx.markPublished(actor.appId, key, version);
      await this.#auditTransition(tx, actor, key, from, version, expected);
      return this.#icon(tx, actor.appId, key);
    });
  }

  /** adminRestoreBuiltinPlatformIcon: back to the bundled image; saved versions are kept. */
  async restore(
    actor: PlatformIconActor,
    rawKey: string,
    body: PlatformIconRestoreBody,
  ): Promise<Icon> {
    const key = keyOf(rawKey);
    const expected = body.expected_revision;
    if (!isCount(expected, 0)) throw new PlatformIconFieldsError(['expected_revision']);
    const editor = this.#editor(actor);
    return this.#store.transaction(async (tx) => {
      const mark = await tx.lockMark(actor.appId, key);
      if (mark.revision !== expected) throw new PlatformIconConflictError();
      if (mark.currentVersion === null) return this.#icon(tx, actor.appId, key);
      if (!(await tx.setCurrent(actor.appId, key, expected, null, editor))) {
        throw new PlatformIconConflictError();
      }
      await this.#auditTransition(tx, actor, key, mark.currentVersion, null, expected);
      return this.#icon(tx, actor.appId, key);
    });
  }

  /** adminCreatePlatformIconVersion: saves an upload as the mark's next version (a draft unless
   * both source_url and downloaded_on are given); a retry with the same upload_id answers the
   * version it was saved as. */
  async create(
    actor: PlatformIconActor,
    rawKey: string,
    body: PlatformIconCreateBody,
  ): Promise<Version> {
    const key = keyOf(rawKey);
    // The route schema has validated the body already; these checks only narrow the types.
    const uploadId = body.upload_id;
    if (typeof uploadId !== 'string') throw new PlatformIconFieldsError(['upload_id']);
    if (body.sanitized_confirmed !== undefined && typeof body.sanitized_confirmed !== 'boolean') {
      throw new PlatformIconFieldsError(['sanitized_confirmed']);
    }
    const confirmed = body.sanitized_confirmed === true;
    const sourceUrl = optionalText(body.source_url, 'source_url');
    const downloadedOn = optionalText(body.downloaded_on, 'downloaded_on');
    const editor = this.#editor(actor);
    try {
      return await this.#store.transaction(async (tx) => {
        const upload = await tx.upload(uploadId);
        if (
          upload === undefined ||
          upload.appId !== actor.appId ||
          upload.key !== key ||
          upload.expiresAt.getTime() <= editor.at.getTime()
        ) {
          throw new PlatformIconFieldsError(['upload_id']);
        }
        await tx.lockMark(actor.appId, key);
        const saved = await tx.savedVersion(actor.appId, key, uploadId);
        if (saved !== undefined) return platformIconVersionOf(saved, this.#mediaPublicBaseUrl);
        if (upload.sanitized && !confirmed) {
          throw new PlatformIconFieldsError(['sanitized_confirmed']);
        }
        const version = (await tx.latestVersion(actor.appId, key)) + 1;
        const created = await tx.insertVersion({
          appId: actor.appId,
          key,
          version,
          uploadId,
          sha256: upload.sha256,
          format: upload.format,
          bytes: upload.bytes,
          sanitized: upload.sanitized,
          sourceUrl,
          downloadedOn,
          editor,
        });
        await tx.touchMark(actor.appId, key, editor);
        await tx.audit({
          appId: actor.appId,
          actor: actor.adminId,
          action: 'version_create',
          target: target(key),
          before: null,
          after: { key, version, upload_id: uploadId },
          ip: actor.ip,
        });
        return platformIconVersionOf(created, this.#mediaPublicBaseUrl);
      });
    } catch (error) {
      if (!isUploadConflict(error)) throw error;
      // Rolled back; the upload is held by the version another request committed.
      const saved = await this.#store.transaction((tx) =>
        tx.savedVersion(actor.appId, key, uploadId),
      );
      if (saved === undefined) throw error;
      return platformIconVersionOf(saved, this.#mediaPublicBaseUrl);
    }
  }

  #editor(actor: PlatformIconActor): PlatformIconEditor {
    return { adminId: actor.adminId, loginName: actor.loginName, at: this.#clock.now() };
  }

  async #auditTransition(
    tx: PlatformIconWriteTx,
    actor: PlatformIconActor,
    key: Key,
    from: number | null,
    to: number | null,
    expected: number,
  ): Promise<void> {
    await tx.audit({
      appId: actor.appId,
      actor: actor.adminId,
      action: transitionAction(from, to),
      target: target(key),
      before: { key, from_version: from, revision: expected },
      after: { key, from_version: from, to_version: to, revision: expected + 1 },
      ip: actor.ip,
    });
  }

  async #icon(tx: PlatformIconWriteTx, appId: string, key: Key): Promise<Icon> {
    const { row, latestVersion } = await tx.icon(appId, key);
    return platformIconOf(key, row, latestVersion, this.#mediaPublicBaseUrl);
  }
}

/** Ruling 8: older than the current version = rollback; from the built-in image always publish. */
export function transitionAction(
  from: number | null,
  to: number | null,
): 'publish' | 'rollback' | 'restore_builtin' {
  if (to === null) return 'restore_builtin';
  return from !== null && to < from ? 'rollback' : 'publish';
}
