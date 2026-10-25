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
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type {
  AuditPort,
  Clock,
  ExportStore,
  FieldCrypto,
  JobHandler,
  JobQueue,
  RootLogger,
} from '../../platform/index.ts';
import type { PersonalDataCopySources } from '../ports/personal-data-copy-sources.ts';

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

export function createDataCopyWorker(options: DataCopyWorkerOptions): DataCopyWorker {
  void options;
  throw new Error('NotImplemented: createDataCopyWorker');
}
