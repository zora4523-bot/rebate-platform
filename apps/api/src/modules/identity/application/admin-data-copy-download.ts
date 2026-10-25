// Download of a wecom_session personal information copy on the console (task B1-27i; 规划/08 BR-ID-40
// 细则「企业微信会话交付的下载」「副本请求与注销状态」; contract adminDownloadUserDataExport, CT-24q). The
// admin operation guard has checked the account, user.data_export and its totp step-up (consumed
// only after a 200 with code 0) before this runs. In order, first hit wins:
//   1. an unknown user of the app → unknown_user (20001 [user_id]);
//   2. the caller no longer active or not holding both user.data_export and pii.reveal_phone →
//      permission_denied (10403), also after the first download;
//   3. one transaction, the request row locked FOR UPDATE: not this user's, not wecom_session or
//      not registered by the caller → unknown_export (20001 [export_id], the same answer as an
//      unknown id); a status other than ready / delivered → not_downloadable(status); expires_at
//      reached (status not changed yet included) or the file gone → not_downloadable(expired); the
//      account's deletion processing or done (its requests are cancelled, its files deleted) →
//      not_downloadable(cancelled);
//   4. ready, or regenerate=true: the sealed file (B1-27h) opened with the field key, a fresh
//      CSPRNG password, a new WinZip AES file under a new key that still names the sealed file
//      (dataCopyDeliveryKey, no migration), the row delivered (delivered_at kept after the first);
//      the first delivery also writes user_data_copy_deliver; else a new link to the same file;
//   5. the link signed (min(5 minutes, expires_at)) and one user_data_copy_download audit record,
//      both before the commit: a failing audit write rolls everything back (the new file deleted).
// A regenerate deletes the voided file after the commit (a failed delete is one warn line). The
// password and the link are never stored, logged or audited; audit keys avoid the redacted
// fragments (phone / token / secret / password ...).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type {
  AuditPort,
  Clock,
  ExportStore,
  FieldCrypto,
  RootLogger,
} from '../../platform/index.ts';
import {
  dataCopyAuditTarget,
  dataCopyDeliveryKey,
  dataCopySealedKeyOf,
  type DataCopyFileReader,
} from '../infra/personal-data-copies.ts';
import { createDeletionStageReader } from '../ports/deletion-stage.ts';
import type { AdminDataCopyRegistrants, AdminDataCopyStatus } from './admin-data-copies.ts';
import { instantPlus } from './config-seconds.ts';
import { DATA_COPY_AUDIT_DELIVER } from './data-copy-worker.ts';
import {
  encryptDataCopyZip,
  generateDataCopySecret,
  openSealedDataCopyEntries,
} from './data-copy-file.ts';

export interface AdminDataCopyDownloadInput {
  readonly appId: string;
  /** The calling admin: must be the request's registrant. */
  readonly adminId: string;
  readonly userId: string;
  readonly exportId: string;
  readonly regenerate: boolean;
  readonly ip: string | null;
}

export type AdminDataCopyDownloadResult =
  | {
      readonly kind: 'link';
      readonly url: string;
      readonly urlExpiresAt: Date;
      /** Only when this call generated it (first download or regenerate); never stored. */
      readonly password: string | null;
      readonly expiresAt: Date;
    }
  | { readonly kind: 'unknown_user' }
  | { readonly kind: 'unknown_export' }
  | { readonly kind: 'not_downloadable'; readonly status: AdminDataCopyStatus }
  | { readonly kind: 'permission_denied' };

export interface AdminDataCopyDownloadOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly store: ExportStore;
  /** Reads the sealed file back (infra createDataCopyFileReader over the same store). */
  readonly files: DataCopyFileReader;
  readonly crypto: FieldCrypto;
  readonly registrants: AdminDataCopyRegistrants;
  readonly auditOn: (db: Kysely<DB>) => AuditPort;
}

export interface AdminDataCopyDownload {
  download(input: AdminDataCopyDownloadInput): Promise<AdminDataCopyDownloadResult>;
}

/** Nest token of the use case (IdentityAdminModule). */
export const ADMIN_DATA_COPY_DOWNLOAD = Symbol('ADMIN_DATA_COPY_DOWNLOAD');
/** The audit action of every call that returns a link (contract adminDownloadUserDataExport). */
export const DATA_COPY_AUDIT_DOWNLOAD = 'user_data_copy_download';
/** BR-ID-40 细则 / BR-ID-42: a signed link lives at most 5 minutes. */
export const DATA_COPY_LINK_MS = 300_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOWNLOADABLE: ReadonlySet<string> = new Set(['ready', 'delivered']);

type Outcome = Exclude<AdminDataCopyDownloadResult, { kind: 'unknown_user' | 'permission_denied' }>;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** min(now + 5 minutes, expiresAt) as a new instant (no `new Date` outside the clock). */
export function dataCopyLinkExpiry(now: Date, expiresAt: Date): Date {
  return instantPlus(now, Math.min(DATA_COPY_LINK_MS, expiresAt.getTime() - now.getTime()));
}

export function createAdminDataCopyDownload(
  options: AdminDataCopyDownloadOptions,
): AdminDataCopyDownload {
  const { db, clock, logger, store, files, crypto, registrants, auditOn } = options;
  const stages = createDeletionStageReader({ db });

  async function downloadOn(
    trx: Transaction<DB>,
    input: AdminDataCopyDownloadInput,
    written: string[],
  ): Promise<{ outcome: Outcome; voided: string | null }> {
    const app = trx.withSchema('app');
    const row = await app
      .selectFrom('personal_data_copies')
      .selectAll()
      .where('app_id', '=', input.appId)
      .where('id', '=', input.exportId)
      .forUpdate()
      .executeTakeFirst();
    const none = { voided: null };
    if (
      row === undefined ||
      row.user_id !== input.userId ||
      row.delivery !== 'wecom_session' ||
      row.requested_by !== input.adminId
    ) {
      return { outcome: { kind: 'unknown_export' }, ...none };
    }
    if (!DOWNLOADABLE.has(row.status)) {
      return {
        outcome: { kind: 'not_downloadable', status: row.status as AdminDataCopyStatus },
        ...none,
      };
    }
    const now = clock.now();
    const expiresAt = row.expires_at;
    if (expiresAt === null || now.getTime() >= expiresAt.getTime() || row.object_key === null) {
      return { outcome: { kind: 'not_downloadable', status: 'expired' }, ...none };
    }
    const stage =
      (await stages.read(trx, { appId: input.appId, userIds: [input.userId] })).get(input.userId) ??
      'none';
    if (stage === 'processing' || stage === 'done') {
      return { outcome: { kind: 'not_downloadable', status: 'cancelled' }, ...none };
    }

    const first = row.status === 'ready';
    let key = row.object_key;
    let password: string | null = null;
    let voided: string | null = null;
    if (first || input.regenerate) {
      const sealedKey = first ? row.object_key : dataCopySealedKeyOf(row.object_key);
      if (sealedKey === null) {
        throw new Error('identity: the delivered copy does not name its sealed file');
      }
      const entries = openSealedDataCopyEntries(await files.read(sealedKey), crypto);
      password = generateDataCopySecret();
      key = dataCopyDeliveryKey(sealedKey);
      written.push(key);
      await store.put({
        key,
        bytes: encryptDataCopyZip(entries, password),
        contentType: 'application/zip',
      });
      voided = first ? null : row.object_key;
      const updated = await app
        .updateTable('personal_data_copies')
        .set({
          status: 'delivered',
          object_key: key,
          delivered_at: row.delivered_at ?? now,
          updated_at: now,
          row_version: row.row_version + 1,
        })
        .where('app_id', '=', input.appId)
        .where('id', '=', row.id)
        .where('row_version', '=', row.row_version)
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) {
        throw new Error('identity: the copy request changed under its row lock');
      }
    }
    const link = await store.signedUrl({ key, expiresAt: dataCopyLinkExpiry(now, expiresAt) });

    const audit = auditOn(trx);
    const target = dataCopyAuditTarget(row.id);
    if (first) {
      // BR-ID-40 细则: the delivery is recorded, its channel the WeCom conversation.
      await audit.append({
        appId: input.appId,
        actor: input.adminId,
        action: DATA_COPY_AUDIT_DELIVER,
        target,
        before: { status: row.status },
        after: {
          copy_id: row.id,
          user_id: row.user_id,
          delivery: 'wecom_session',
          result: 'delivered',
          status: 'delivered',
          channels: 'wecom_session',
          delivered_at: now.toISOString(),
        },
        ip: input.ip,
      });
    }
    await audit.append({
      appId: input.appId,
      actor: input.adminId,
      action: DATA_COPY_AUDIT_DOWNLOAD,
      target,
      before: { status: row.status },
      after: {
        copy_id: row.id,
        user_id: row.user_id,
        delivery: 'wecom_session',
        regenerate: input.regenerate,
        first_delivery: first,
        new_file: password !== null,
      },
      ip: input.ip,
    });
    return {
      outcome: {
        kind: 'link',
        url: link.url,
        urlExpiresAt: link.expiresAt,
        password,
        expiresAt,
      },
      voided,
    };
  }

  async function discard(input: AdminDataCopyDownloadInput, key: string | null, event: string) {
    if (key === null) return;
    try {
      await store.delete(key);
    } catch (error) {
      logger.warn(
        { app_id: input.appId, copy_id: input.exportId, error_name: errorName(error) },
        event,
      );
    }
  }

  async function download(input: AdminDataCopyDownloadInput): Promise<AdminDataCopyDownloadResult> {
    if (!UUID.test(input.userId)) return { kind: 'unknown_user' };
    const user = await db
      .withSchema('app')
      .selectFrom('users')
      .select('id')
      .where('app_id', '=', input.appId)
      .where('id', '=', input.userId)
      .executeTakeFirst();
    if (user === undefined) return { kind: 'unknown_user' };
    if (!(await registrants.canDownload(db, input.appId, input.adminId))) {
      return { kind: 'permission_denied' };
    }
    if (!UUID.test(input.exportId)) return { kind: 'unknown_export' };
    const normalized = {
      ...input,
      userId: input.userId.toLowerCase(),
      exportId: input.exportId.toLowerCase(),
    };
    const written: string[] = [];
    let done: { outcome: Outcome; voided: string | null };
    try {
      done = await db.transaction().execute((trx) => downloadOn(trx, normalized, written));
    } catch (error) {
      // Nothing was committed: the file this call put is not any request's.
      for (const key of written) {
        await discard(normalized, key, 'identity_data_copy_download_file_discard_failed');
      }
      throw error;
    }
    await discard(normalized, done.voided, 'identity_data_copy_voided_file_delete_failed');
    if (done.outcome.kind === 'link') {
      logger.info(
        {
          app_id: normalized.appId,
          copy_id: normalized.exportId,
          regenerate: normalized.regenerate,
        },
        'identity_data_copy_downloaded',
      );
    }
    return done.outcome;
  }

  return Object.freeze({ download });
}
