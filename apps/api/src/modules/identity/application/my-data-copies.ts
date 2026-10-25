// The App's own personal information copies (task B1-27i; 规划/08 BR-ID-40 细则「在 App 内下载」
// 「副本请求与注销状态」; contract listMyDataCopies / getMyDataCopyDownload, CT-24q). Read only, no
// audit. A copy is the caller's when it is of the token's app and user, in_app_sms, ready or
// delivered, expires_at not yet reached and its file still recorded; the list is newest generated
// first, and a download signs a new link valid min(5 minutes, expires_at) to it. Anything else is
// one not_found (30701) for every case. Once the account's deletion is processing or done
// (deletion-stage: the deletion request or users.status) the list is empty and every download is
// not_found. Ban, cooling and the deletion_only scope are the request checks' (10006 whitelist,
// x-session-scopes); the extraction code is never read here.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, ExportStore } from '../../platform/index.ts';
import { createDeletionStageReader } from '../ports/deletion-stage.ts';
import { dataCopyLinkExpiry } from './admin-data-copy-download.ts';

export interface MyDataCopySubject {
  readonly appId: string;
  readonly userId: string;
}

export interface MyDataCopyItem {
  readonly copyId: string;
  readonly status: 'ready' | 'delivered';
  readonly generatedAt: Date;
  readonly expiresAt: Date;
}

export type MyDataCopyDownloadResult =
  | { readonly kind: 'link'; readonly url: string; readonly urlExpiresAt: Date }
  | { readonly kind: 'not_found' };

export interface MyDataCopiesOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly store: ExportStore;
}

export interface MyDataCopies {
  list(subject: MyDataCopySubject): Promise<readonly MyDataCopyItem[]>;
  download(subject: MyDataCopySubject, copyId: string): Promise<MyDataCopyDownloadResult>;
}

/** Nest token of the use case (IdentityModule). */
export const MY_DATA_COPIES = Symbol('MY_DATA_COPIES');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createMyDataCopies(options: MyDataCopiesOptions): MyDataCopies {
  const { db, clock, store } = options;
  const stages = createDeletionStageReader({ db });

  async function deleting(subject: MyDataCopySubject): Promise<boolean> {
    const stage =
      (await stages.read(db, { appId: subject.appId, userIds: [subject.userId] })).get(
        subject.userId,
      ) ?? 'none';
    return stage === 'processing' || stage === 'done';
  }

  const usable = (subject: MyDataCopySubject, now: Date) =>
    db
      .withSchema('app')
      .selectFrom('personal_data_copies')
      .select(['id', 'status', 'object_key', 'generated_at', 'expires_at'])
      .where('app_id', '=', subject.appId)
      .where('user_id', '=', subject.userId)
      .where('delivery', '=', 'in_app_sms')
      .where('status', 'in', ['ready', 'delivered'])
      .where('object_key', 'is not', null)
      .where('generated_at', 'is not', null)
      .where('expires_at', '>', now);

  async function list(subject: MyDataCopySubject): Promise<readonly MyDataCopyItem[]> {
    if (!UUID.test(subject.userId) || (await deleting(subject))) return [];
    const rows = await usable(subject, clock.now())
      .orderBy('generated_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return rows.map((row) => ({
      copyId: row.id,
      status: row.status as MyDataCopyItem['status'],
      generatedAt: row.generated_at!,
      expiresAt: row.expires_at!,
    }));
  }

  async function download(
    subject: MyDataCopySubject,
    copyId: string,
  ): Promise<MyDataCopyDownloadResult> {
    if (!UUID.test(subject.userId) || !UUID.test(copyId)) return { kind: 'not_found' };
    if (await deleting(subject)) return { kind: 'not_found' };
    const now = clock.now();
    const row = await usable(subject, now)
      .where('id', '=', copyId.toLowerCase())
      .executeTakeFirst();
    if (row === undefined || row.object_key === null || row.expires_at === null) {
      return { kind: 'not_found' };
    }
    const link = await store.signedUrl({
      key: row.object_key,
      expiresAt: dataCopyLinkExpiry(now, row.expires_at),
    });
    return { kind: 'link', url: link.url, urlExpiresAt: link.expiresAt };
  }

  return Object.freeze({ list, download });
}
