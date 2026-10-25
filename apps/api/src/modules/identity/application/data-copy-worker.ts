// Generation and delivery of personal information copies (规划/08 BR-ID-40 细则「交付（默认）」
// 「企业微信会话交付的下载」「副本请求与注销状态」「重新登记与登记人停用」, BR-ID-30 ⑨; 04 §3.2
// personal_data_copies; contract CT-24q; task B1-27h brief §9 ①–⑤). Handler of queue `data-copy`
// (worker entry only), payload { appId, copyId } with copyId the request's id; job names:
//   - generate: pending → running under a lease (updated_at the heartbeat, row_version the fencing
//     token, as B1-34e's export worker), the sections read through PersonalDataCopySources, the
//     archive put into the private export store under a key of its own per run (D10-138), the token
//     checked before anything leaves the process and before completing. in_app_sms: encrypted with a
//     one-time extraction code, the code by SMS to the bound phone (template DATA_COPY_CODE), the
//     inbox message DATA_COPY_READY with only the App page DataCopy as its target (no link), then
//     delivered; wecom_session: sealed under the server key and ready (the registrant's first
//     download delivers it, B1-27i). expires_at = generated_at + 24 hours with a delayed expire
//     job in the completing transaction. Any failure is failed (failure_reason, no half delivery,
//     the run's object deleted). Generation and delivery each write an audit row
//     (user_data_copy_generate, user_data_copy_deliver) under the registrant's id; the code never
//     reaches the database, the logs, the audit or the queue.
//   - expire: at expires_at the file is deleted (object_key cleared); ready / delivered → expired.
// A duplicate or late delivery of either job changes nothing.
//
// Lease (no extra column, as B1-34e): updated_at is the heartbeat, row_version the fencing token;
// every write of a run is a CAS on the token it holds. A running request whose updated_at is older
// than the lease is taken over by the next generate delivery (its recorded file deleted first, under
// the row lock); a running one within the lease gets one delayed generate re-check. Right before the
// upload the run records its own key in object_key (so a file is always findable), and a run whose
// completion misses its token (cancelled by the deletion cleanup, failed by the registrant's
// disable, or taken over) deletes its own file and clears object_key again.
// in_app_sms delivery is one transaction: the row becomes delivered, both audit rows and the expire
// job are written, the inbox message recorded, and the SMS sent last; an SMS that is not accepted
// (rejected, unknown or thrown) or a failing inbox write rolls it back and the request fails with
// its file deleted, so the user never gets the code without the inbox entry or the reverse. The
// push of the inbox message is dispatched after the commit (its outcome does not change delivery).
// The content is read in one REPEATABLE READ READ ONLY transaction without locking the users row.
// Logs carry ids and error class names only; failure_reason is a fixed safe text.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import { randomBytes } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { dataCopyObjectKey } from '../../platform/index.ts';
import type {
  AuditPort,
  Clock,
  ExportPutInput,
  ExportStore,
  FieldCrypto,
  JobHandler,
  JobQueue,
  ReceivedJob,
  RootLogger,
} from '../../platform/index.ts';
import { dataCopyAuditTarget } from '../infra/personal-data-copies.ts';
import type {
  PersonalDataCopySources,
  PersonalDataCopySubject,
} from '../ports/personal-data-copy-sources.ts';
import { instantPlus } from './config-seconds.ts';
import {
  dataCopyFileEntries,
  encryptDataCopyZip,
  generateDataCopySecret,
  sealDataCopyEntries,
  type PersonalDataCopyContent,
} from './data-copy-file.ts';

export type DataCopySmsResult = 'accepted' | 'rejected' | 'unknown';

/** One template SMS (structurally notification's TemplateSmsMessage). */
export interface DataCopySmsMessage {
  readonly appId: string;
  readonly phone: string;
  readonly template: string;
  readonly params: Record<string, string>;
  readonly outId?: string;
}

/** The SMS port of the extraction code (app.module: notification's template SMS sender). */
export interface DataCopyCodeSender {
  send(message: DataCopySmsMessage): Promise<DataCopySmsResult>;
}

export type DataCopyPushCategory = 'service' | 'subscription' | 'marketing';

/** One inbox message with its push (structurally notification's PushSendInput). */
export interface DataCopyInboxInput {
  readonly app_id: string;
  readonly user_id: string;
  readonly code: string;
  readonly variant: string;
  readonly eventKey: string;
  readonly title: string;
  readonly body: string;
  readonly route: Readonly<Record<string, unknown>> | null;
  readonly category: DataCopyPushCategory;
}

export type DataCopyInboxEvent = Pick<
  DataCopyInboxInput,
  'app_id' | 'user_id' | 'code' | 'variant' | 'eventKey' | 'category'
>;

/** The inbox port (app.module: notification's push sending core, record then dispatch). */
export interface DataCopyInbox {
  record(transaction: Transaction<DB>, input: DataCopyInboxInput): Promise<void>;
  dispatch(db: Kysely<DB>, event: DataCopyInboxEvent): Promise<unknown>;
}

export interface DataCopyWorkerOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly store: ExportStore;
  readonly sources: PersonalDataCopySources;
  /** The server key of wecom_session files. */
  readonly crypto: FieldCrypto;
  readonly sms: DataCopyCodeSender;
  readonly inbox: DataCopyInbox;
  /** Binds the audit port to a handle (app.module: admin's createAuditWriter). */
  readonly auditWriter: (db: Kysely<DB>, clock: Clock) => AuditPort;
  readonly logger: RootLogger;
}

export interface DataCopyWorker {
  /** data-copy queue: generate / expire; payload { appId, copyId }. */
  readonly handle: JobHandler;
}

export const DATA_COPY_QUEUE = 'data-copy';
export const DATA_COPY_GENERATE_JOB = 'generate';
export const DATA_COPY_EXPIRE_JOB = 'expire';
export const DATA_COPY_AUDIT_GENERATE = 'user_data_copy_generate';
export const DATA_COPY_AUDIT_DELIVER = 'user_data_copy_deliver';
/** BR-TEXT-23 细则「个人信息副本的交付通知」. */
export const DATA_COPY_INBOX_CODE = 'DATA_COPY_READY';
export const DATA_COPY_SMS_TEMPLATE = 'DATA_COPY_CODE';
export const DATA_COPY_ROUTE = 'DataCopy';
/** BR-ID-30 ⑨: the file expires 24 hours after generation. */
export const DATA_COPY_WINDOW_MS = 86_400_000;
/** A running request without a heartbeat for this long counts as interrupted. */
export const DATA_COPY_LEASE_MS = 600_000;
/** Added to the lease's remaining time for the delayed re-check of a running request. */
const RECHECK_EXTRA_SECONDS = 15;
const BEIJING_OFFSET_MS = 8 * 3_600_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_ID = /^[a-z0-9_]{1,32}$/;
const GONE_USER_STATUSES: ReadonlySet<string> = new Set(['deleting', 'deleted']);
const GENERATED_STATUSES: ReadonlySet<string> = new Set(['ready', 'delivered']);

// TODO(规划/11 §2.3): 站内信标题与正文的定稿文案 — blocked on 08 BR-TEXT 登记（契约：模板代码随实现定，文案待 BR-TEXT）
const INBOX_TITLE = '个人信息副本已生成';
const INBOX_BODY =
  '你申请的个人信息副本已生成，请在 App 的「个人信息副本」页下载；提取码已通过短信发送到你绑定的手机号。文件 24 小时后失效。';

const REASON_SOURCE = '读取副本数据失败，请重新登记';
const REASON_ACCOUNT = '账号不存在，无法生成副本';
const REASON_NO_PHONE = '绑定手机号不可用，无法发送提取码';
const REASON_BUILD = '副本文件生成失败，请重新登记';
const REASON_STORAGE = '副本文件存放失败，请重新登记';
const REASON_INBOX = '站内信写入失败，副本未交付';
const REASON_SMS = '提取码短信发送失败，副本未交付';
const REASON_COMPLETE = '副本生成未能完成，请重新登记';

type CopyRow = Selectable<DB['personal_data_copies']>;
type Delivery = 'in_app_sms' | 'wecom_session';

/** One run's hold on a running request: `token` is the row_version it last wrote. */
interface Lease {
  readonly copy: CopyRow;
  readonly run: string;
  token: number;
}

interface Built {
  readonly bytes: Uint8Array;
  readonly contentType: ExportPutInput['contentType'];
  /** in_app_sms: the extraction code and the bound phone (never stored, logged or audited). */
  readonly sms: { readonly code: string; readonly phone: string } | null;
}

/** The inbox write of the delivery failed: the delivery transaction rolls back. */
class DataCopyInboxError extends Error {
  constructor() {
    super('data copy: the inbox message could not be recorded');
    this.name = 'DataCopyInboxError';
  }
}

/** The extraction code SMS was not accepted: the delivery transaction rolls back. */
class DataCopySmsError extends Error {
  constructor() {
    super('data copy: the extraction code SMS was not accepted');
    this.name = 'DataCopySmsError';
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function delaySecondsUntil(target: Date, now: Date): number {
  return Math.max(1, Math.ceil((target.getTime() - now.getTime()) / 1000));
}

/** expires_at as the SMS shows it: `YYYY-MM-DD HH:mm` at +08:00. */
function beijingMinute(instant: Date): string {
  return instantPlus(instant, BEIJING_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

export function createDataCopyWorker(options: DataCopyWorkerOptions): DataCopyWorker {
  const { clock, queue, store, sources, crypto, sms, inbox, logger } = options;
  const root = options.db;
  const db = root.withSchema('app');
  const auditOn = (trx: Transaction<DB>): AuditPort =>
    options.auditWriter(trx.withSchema('app'), clock);

  const lockCopy = (trx: Transaction<DB>, appId: string, copyId: string) =>
    trx
      .withSchema('app')
      .selectFrom('personal_data_copies')
      .selectAll()
      .where('app_id', '=', appId)
      .where('id', '=', copyId)
      .forUpdate()
      .executeTakeFirst();

  /** users.status without a lock (the deletion cleanup locks users first, then the copies). */
  const userStatus = async (trx: Transaction<DB>, copy: CopyRow): Promise<string | undefined> => {
    const user = await trx
      .withSchema('app')
      .selectFrom('users')
      .select('status')
      .where('app_id', '=', copy.app_id)
      .where('id', '=', copy.user_id)
      .executeTakeFirst();
    return user?.status;
  };

  const audit = (
    trx: Transaction<DB>,
    copy: CopyRow,
    action: string,
    before: string,
    after: Record<string, string | null>,
  ) =>
    auditOn(trx).append({
      appId: copy.app_id,
      actor: copy.requested_by,
      action,
      target: dataCopyAuditTarget(copy.id),
      before: { status: before },
      after: { copy_id: copy.id, user_id: copy.user_id, delivery: copy.delivery, ...after },
      ip: null,
    });

  const sendExpire = (trx: Transaction<DB> | null, copy: CopyRow, expiresAt: Date, now: Date) =>
    queue.send(
      DATA_COPY_QUEUE,
      DATA_COPY_EXPIRE_JOB,
      { appId: copy.app_id, copyId: copy.id },
      { trx, delaySeconds: delaySecondsUntil(expiresAt, now) },
    );

  /**
   * Under the row lock: pending → running, or a running request whose lease ran out taken over
   * (its recorded file deleted first; a failing delete rolls back and the job is retried). A
   * running request within the lease gets a delayed re-check; an account in processing (or gone)
   * cancels the request. null when this delivery has nothing to run.
   */
  async function claim(appId: string, copyId: string): Promise<Lease | null> {
    return root.transaction().execute(async (trx) => {
      const row = await lockCopy(trx, appId, copyId);
      if (row === undefined) return null;
      const now = clock.now();
      const takeover = row.status === 'running';
      if (takeover) {
        const leaseEnds = instantPlus(row.updated_at, DATA_COPY_LEASE_MS);
        if (leaseEnds.getTime() > now.getTime()) {
          await queue.send(
            DATA_COPY_QUEUE,
            DATA_COPY_GENERATE_JOB,
            { appId, copyId },
            { trx, delaySeconds: delaySecondsUntil(leaseEnds, now) + RECHECK_EXTRA_SECONDS },
          );
          return null;
        }
      } else if (row.status !== 'pending') {
        return null;
      }
      const status = await userStatus(trx, row);
      if (status === undefined || GONE_USER_STATUSES.has(status)) {
        // BR-ID-40 细则「副本请求与注销状态」: an account in processing gets no copy.
        await trx
          .withSchema('app')
          .updateTable('personal_data_copies')
          .set({ status: 'cancelled', updated_at: now, row_version: row.row_version + 1 })
          .where('id', '=', row.id)
          .where('status', '=', row.status)
          .where('row_version', '=', row.row_version)
          .execute();
        logger.info({ app_id: appId, copy_id: copyId }, 'identity_data_copy_cancelled_deleting');
        return null;
      }
      if (takeover && row.object_key !== null) await store.delete(row.object_key);
      const claimed = await trx
        .withSchema('app')
        .updateTable('personal_data_copies')
        .set({
          status: 'running',
          object_key: null,
          updated_at: now,
          row_version: row.row_version + 1,
        })
        .where('id', '=', row.id)
        .where('status', '=', row.status)
        .where('row_version', '=', row.row_version)
        .returningAll()
        .executeTakeFirst();
      if (claimed === undefined) return null;
      if (takeover) {
        logger.warn({ app_id: appId, copy_id: copyId }, 'identity_data_copy_lease_taken_over');
      }
      return {
        copy: claimed,
        run: randomBytes(9).toString('base64url'),
        token: claimed.row_version,
      };
    });
  }

  /** Every section, in one consistent read-only snapshot, for the request's member only. */
  async function read(copy: CopyRow): Promise<PersonalDataCopyContent> {
    const subject: PersonalDataCopySubject = { appId: copy.app_id, userId: copy.user_id };
    return root
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(async (trx) => ({
        account: await sources.account(trx, subject),
        realname: await sources.realname(trx, subject),
        consents: await sources.consents(trx, subject),
        orders: await sources.orders(trx, subject),
        ledger: await sources.ledger(trx, subject),
        withdrawals: await sources.withdrawals(trx, subject),
        agent: await sources.agent(trx, subject),
        invite: await sources.invite(trx, subject),
      }));
  }

  /** Records this run's key before the upload (heartbeat, CAS on the token); false: lease lost. */
  async function record(lease: Lease, key: string): Promise<boolean> {
    const result = await db
      .updateTable('personal_data_copies')
      .set({ object_key: key, updated_at: clock.now(), row_version: lease.token + 1 })
      .where('app_id', '=', lease.copy.app_id)
      .where('id', '=', lease.copy.id)
      .where('status', '=', 'running')
      .where('row_version', '=', lease.token)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) return false;
    lease.token += 1;
    return true;
  }

  /**
   * Under the row lock, when the file of `key` can no longer become this run's result: the file
   * is deleted and, where the row records it, object_key cleared. A failing delete of a recorded
   * file leaves it to an expire job (expires_at set and one sent when the row had none).
   */
  async function release(trx: Transaction<DB>, row: CopyRow, key: string, now: Date) {
    let deleted = true;
    try {
      await store.delete(key);
    } catch (error) {
      deleted = false;
      logger.warn(
        { app_id: row.app_id, copy_id: row.id, error_name: errorName(error) },
        'identity_data_copy_file_delete_failed',
      );
    }
    if (row.object_key !== key) return { objectKey: row.object_key, expiresAt: row.expires_at };
    if (deleted) return { objectKey: null, expiresAt: row.expires_at };
    const expiresAt = row.expires_at ?? instantPlus(now, DATA_COPY_WINDOW_MS);
    if (row.expires_at === null) await sendExpire(trx, row, expiresAt, now);
    return { objectKey: key, expiresAt };
  }

  /** The run lost its request (cancelled, failed by a disable, taken over): its file goes. */
  async function abandon(lease: Lease, key: string): Promise<void> {
    await root.transaction().execute(async (trx) => {
      const row = await lockCopy(trx, lease.copy.app_id, lease.copy.id);
      if (row === undefined) return;
      const now = clock.now();
      const kept = await release(trx, row, key, now);
      if (kept.objectKey === row.object_key && kept.expiresAt === row.expires_at) return;
      await trx
        .withSchema('app')
        .updateTable('personal_data_copies')
        .set({
          object_key: kept.objectKey,
          expires_at: kept.expiresAt,
          updated_at: now,
          row_version: row.row_version + 1,
        })
        .where('id', '=', row.id)
        .where('row_version', '=', row.row_version)
        .execute();
    });
    logger.info(
      { app_id: lease.copy.app_id, copy_id: lease.copy.id },
      'identity_data_copy_run_lost',
    );
  }

  /**
   * running → failed under the run's token, with the audit rows of the failed step (generation;
   * or delivery after a generated file), and the run's file deleted. A run that lost its token
   * writes nothing but still deletes its own file (abandon).
   */
  async function fail(
    lease: Lease,
    key: string | null,
    reason: string,
    step: 'generate' | 'deliver',
  ): Promise<void> {
    const applied = await root.transaction().execute(async (trx) => {
      const row = await lockCopy(trx, lease.copy.app_id, lease.copy.id);
      if (row === undefined) return 'lost';
      if (row.status !== 'running' || row.row_version !== lease.token) return 'lost';
      const now = clock.now();
      const kept =
        key === null
          ? { objectKey: row.object_key, expiresAt: row.expires_at }
          : await release(trx, row, key, now);
      const result = await trx
        .withSchema('app')
        .updateTable('personal_data_copies')
        .set({
          status: 'failed',
          failure_reason: reason,
          object_key: kept.objectKey,
          expires_at: kept.expiresAt,
          updated_at: now,
          row_version: lease.token + 1,
        })
        .where('id', '=', row.id)
        .where('status', '=', 'running')
        .where('row_version', '=', lease.token)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) return 'lost';
      if (step === 'generate') {
        await audit(trx, row, DATA_COPY_AUDIT_GENERATE, 'running', {
          result: 'failed',
          status: 'failed',
          reason,
        });
      } else {
        await audit(trx, row, DATA_COPY_AUDIT_GENERATE, 'running', {
          result: 'generated',
          status: 'failed',
        });
        await audit(trx, row, DATA_COPY_AUDIT_DELIVER, 'running', {
          result: 'failed',
          status: 'failed',
          reason,
        });
      }
      return 'failed';
    });
    if (applied === 'lost') {
      if (key !== null) await abandon(lease, key);
      return;
    }
    lease.token += 1;
    logger.info(
      { app_id: lease.copy.app_id, copy_id: lease.copy.id, step },
      'identity_data_copy_failed',
    );
  }

  /** The file of the request: encrypted ZIP with a fresh code (in_app_sms) or sealed. */
  function build(copy: CopyRow, content: PersonalDataCopyContent): Built | string {
    const account = content.account;
    if (account === null) return REASON_ACCOUNT;
    const entries = dataCopyFileEntries(content);
    if ((copy.delivery as Delivery) === 'in_app_sms') {
      const phone = account.phone;
      if (phone === null || phone.trim() === '') return REASON_NO_PHONE;
      const code = generateDataCopySecret();
      return {
        bytes: encryptDataCopyZip(entries, code),
        contentType: 'application/zip',
        sms: { code, phone },
      };
    }
    return {
      bytes: sealDataCopyEntries(entries, crypto),
      contentType: 'application/octet-stream',
      sms: null,
    };
  }

  /**
   * Under the row lock and the run's token: ready (wecom_session), or delivered with the inbox
   * message and the SMS (in_app_sms); the audit rows and the delayed expire job in the same
   * transaction. 'lost' when the request is no longer this run's (cancelled when the account
   * entered processing meanwhile).
   */
  async function complete(lease: Lease, key: string, built: Built): Promise<'done' | 'lost'> {
    return root.transaction().execute(async (trx) => {
      const row = await lockCopy(trx, lease.copy.app_id, lease.copy.id);
      if (row === undefined || row.status !== 'running' || row.row_version !== lease.token) {
        return 'lost';
      }
      const now = clock.now();
      const status = await userStatus(trx, row);
      if (status === undefined || GONE_USER_STATUSES.has(status)) {
        await trx
          .withSchema('app')
          .updateTable('personal_data_copies')
          .set({ status: 'cancelled', updated_at: now, row_version: lease.token + 1 })
          .where('id', '=', row.id)
          .where('status', '=', 'running')
          .where('row_version', '=', lease.token)
          .execute();
        return 'lost';
      }
      const expiresAt = instantPlus(now, DATA_COPY_WINDOW_MS);
      const delivered = built.sms !== null;
      const result = await trx
        .withSchema('app')
        .updateTable('personal_data_copies')
        .set({
          status: delivered ? 'delivered' : 'ready',
          object_key: key,
          generated_at: now,
          delivered_at: delivered ? now : null,
          expires_at: expiresAt,
          failure_reason: null,
          updated_at: now,
          row_version: lease.token + 1,
        })
        .where('id', '=', row.id)
        .where('status', '=', 'running')
        .where('row_version', '=', lease.token)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) return 'lost';
      await audit(trx, row, DATA_COPY_AUDIT_GENERATE, 'running', {
        result: 'generated',
        status: delivered ? 'delivered' : 'ready',
        generated_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
      });
      await sendExpire(trx, row, expiresAt, now);
      if (built.sms !== null) {
        await audit(trx, row, DATA_COPY_AUDIT_DELIVER, 'running', {
          result: 'delivered',
          status: 'delivered',
          channels: 'inbox+sms',
          delivered_at: now.toISOString(),
        });
        try {
          await inbox.record(trx, inboxInput(row));
        } catch {
          throw new DataCopyInboxError();
        }
        let answer: DataCopySmsResult;
        try {
          answer = await sms.send({
            appId: row.app_id,
            phone: built.sms.phone,
            template: DATA_COPY_SMS_TEMPLATE,
            params: { code: built.sms.code, expires_at: beijingMinute(expiresAt) },
          });
        } catch {
          throw new DataCopySmsError();
        }
        if (answer !== 'accepted') throw new DataCopySmsError();
      }
      return 'done';
    });
  }

  function inboxInput(row: CopyRow): DataCopyInboxInput {
    return {
      app_id: row.app_id,
      user_id: row.user_id,
      code: DATA_COPY_INBOX_CODE,
      variant: 'default',
      eventKey: `data_copy_ready:${row.id}`,
      title: INBOX_TITLE,
      body: INBOX_BODY,
      route: { route: DATA_COPY_ROUTE, params: {} },
      category: 'service',
    };
  }

  async function generate(appId: string, copyId: string): Promise<void> {
    const lease = await claim(appId, copyId);
    if (lease === null) return;
    const { copy } = lease;
    const ids = { app_id: appId, copy_id: copyId };

    let content: PersonalDataCopyContent;
    try {
      content = await read(copy);
    } catch (error) {
      logger.warn({ ...ids, error_name: errorName(error) }, 'identity_data_copy_source_failed');
      await fail(lease, null, REASON_SOURCE, 'generate');
      return;
    }

    let built: Built | string;
    try {
      built = build(copy, content);
    } catch (error) {
      logger.warn({ ...ids, error_name: errorName(error) }, 'identity_data_copy_build_failed');
      built = REASON_BUILD;
    }
    if (typeof built === 'string') {
      await fail(lease, null, built, 'generate');
      return;
    }

    const key = dataCopyObjectKey(appId, copyId, lease.run);
    // Still this run's right before the upload; the key is recorded first.
    if (!(await record(lease, key))) return;
    try {
      await store.put({ key, bytes: built.bytes, contentType: built.contentType });
    } catch (error) {
      logger.warn({ ...ids, error_name: errorName(error) }, 'identity_data_copy_store_failed');
      await fail(lease, key, REASON_STORAGE, 'generate');
      return;
    }

    let outcome: 'done' | 'lost';
    try {
      outcome = await complete(lease, key, built);
    } catch (error) {
      logger.warn({ ...ids, error_name: errorName(error) }, 'identity_data_copy_complete_failed');
      if (error instanceof DataCopySmsError) await fail(lease, key, REASON_SMS, 'deliver');
      else if (error instanceof DataCopyInboxError) await fail(lease, key, REASON_INBOX, 'deliver');
      else await fail(lease, key, REASON_COMPLETE, 'generate');
      return;
    }
    if (outcome === 'lost') {
      await abandon(lease, key);
      return;
    }
    lease.token += 1;
    logger.info({ ...ids, delivery: copy.delivery }, 'identity_data_copy_generated');
    if (built.sms !== null) {
      const event = inboxInput(copy);
      try {
        await inbox.dispatch(root, {
          app_id: event.app_id,
          user_id: event.user_id,
          code: event.code,
          variant: event.variant,
          eventKey: event.eventKey,
          category: event.category,
        });
      } catch (error) {
        // Delivered either way: the inbox message is there; the push is best effort.
        logger.warn({ ...ids, error_name: errorName(error) }, 'identity_data_copy_push_failed');
      }
    }
  }

  /**
   * At expires_at: the file deleted under the row lock (a failing delete rolls back and the job is
   * retried), object_key cleared, ready / delivered → expired (other statuses keep theirs). An
   * early delivery sends one delayed expire for the remaining time.
   */
  async function expire(appId: string, copyId: string): Promise<void> {
    const outcome = await root.transaction().execute(async (trx) => {
      const row = await lockCopy(trx, appId, copyId);
      if (row === undefined || row.expires_at === null) return 'ignored';
      const pendingWork = row.object_key !== null || GENERATED_STATUSES.has(row.status);
      if (!pendingWork) return 'ignored';
      const now = clock.now();
      if (now.getTime() < row.expires_at.getTime()) {
        await sendExpire(trx, row, row.expires_at, now);
        return 'early';
      }
      if (row.object_key !== null) await store.delete(row.object_key);
      await trx
        .withSchema('app')
        .updateTable('personal_data_copies')
        .set({
          status: GENERATED_STATUSES.has(row.status) ? 'expired' : row.status,
          object_key: null,
          updated_at: now,
          row_version: row.row_version + 1,
        })
        .where('id', '=', row.id)
        .where('row_version', '=', row.row_version)
        .execute();
      return 'expired';
    });
    if (outcome === 'expired') {
      logger.info({ app_id: appId, copy_id: copyId }, 'identity_data_copy_expired');
    }
  }

  return Object.freeze({
    async handle(job: ReceivedJob): Promise<void> {
      const appId = job.payload['appId'];
      const copyId = job.payload['copyId'];
      if (
        typeof appId !== 'string' ||
        !APP_ID.test(appId) ||
        typeof copyId !== 'string' ||
        !UUID.test(copyId)
      ) {
        logger.warn({ job_id: job.id }, 'identity_data_copy_job_invalid');
        return;
      }
      const id = copyId.toLowerCase();
      if (job.name === DATA_COPY_GENERATE_JOB) return generate(appId, id);
      if (job.name === DATA_COPY_EXPIRE_JOB) return expire(appId, id);
      logger.warn({ job_id: job.id }, 'identity_data_copy_job_unknown');
    },
  });
}
