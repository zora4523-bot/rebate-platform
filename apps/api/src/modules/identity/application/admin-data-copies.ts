// Registration and list of personal information copy requests on the console (task B1-27c; 规划/08
// BR-ID-40 细则「截止时刻」「副本请求与注销状态」「企业微信会话交付的下载」「重新登记与登记人停用」; contract
// adminCreateUserDataExport / adminListUserDataExports, CT-24q). The admin operation guard has
// checked the account, user.data_export and (registration) its totp step-up, and the route schema
// the body, before this runs. Registration, first hit wins: the account's deletion in processing
// or done; the user's unfinished request returned (reused) unless it is an undelivered
// wecom_session one whose registrant can no longer download it (then failed and replaced); the
// delivery from the two channel facts. A new request is pending, due 24:00 (+08:00) of the 15th
// working day after the registration date or the due_at of the request it replaces, inserted with
// its data-copy generate job on one transaction; every registration writes one audit record.
//
// Skeleton of the rule-test phase: every function throws NotImplemented.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { AuditPort, Clock, JobQueue, RootLogger } from '../../platform/index.ts';
import type { DeletionCalendarConfigReader } from './deletion-expiry.ts';

export type AdminDataCopyDelivery = 'in_app_sms' | 'wecom_session';
export type AdminDataCopyStatus =
  'pending' | 'running' | 'ready' | 'delivered' | 'failed' | 'expired' | 'cancelled';

/** A request as the console shows it (never an object key, link, code or password). */
export interface AdminDataCopyView {
  readonly exportId: string;
  readonly userId: string;
  readonly delivery: AdminDataCopyDelivery;
  readonly status: AdminDataCopyStatus;
  readonly requestedBy: string;
  readonly requestedByName: string | null;
  readonly createdAt: Date;
  readonly dueAt: Date;
  readonly retryOf: string | null;
  readonly generatedAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly expiresAt: Date | null;
  readonly failureReason: string | null;
}

export interface AdminDataCopyRegisterInput {
  readonly appId: string;
  /** The calling admin (requested_by of a new request; the audit actor). */
  readonly adminId: string;
  /** Whether the caller also holds pii.reveal_phone (super admins hold every point). */
  readonly callerCanDownload: boolean;
  readonly userId: string;
  readonly reason: string;
  readonly appLoginOk: boolean;
  readonly phoneSmsOk: boolean;
  readonly ip: string | null;
}

export type AdminDataCopyRegisterResult =
  | { readonly kind: 'registered'; readonly view: AdminDataCopyView; readonly reused: boolean }
  | { readonly kind: 'unknown_user' }
  | { readonly kind: 'account_deleting' }
  | { readonly kind: 'account_deleted' }
  | { readonly kind: 'delivery_undecided' }
  | { readonly kind: 'phone_missing' }
  | { readonly kind: 'permission_denied' };

export interface AdminDataCopyListInput {
  readonly appId: string;
  readonly userId: string;
  readonly page: number;
  readonly pageSize: number;
}

export type AdminDataCopyListResult =
  | { readonly kind: 'page'; readonly items: readonly AdminDataCopyView[]; readonly total: number }
  | { readonly kind: 'unknown_user' };

/** admin's side of the registrants (identity never reads admin's tables itself). */
export interface AdminDataCopyRegistrants {
  /** The account is active and holds both user.data_export and pii.reveal_phone (or is super). */
  canDownload(db: Kysely<DB>, appId: string, adminId: string): Promise<boolean>;
  /** Current names (display_name, else the username) of the given accounts. */
  names(
    db: Kysely<DB>,
    appId: string,
    adminIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}

export interface AdminDataCopiesOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly queue: JobQueue;
  /** The working-day calendar (calendar.cn_holidays.<year>, calendar.cn_makeup_workdays.<year>). */
  readonly calendar: DeletionCalendarConfigReader;
  readonly registrants: AdminDataCopyRegistrants;
  /** Binds the audit port to a handle (app.module: admin's createAuditWriter). */
  readonly auditOn: (db: Kysely<DB>) => AuditPort;
}

export interface AdminDataCopies {
  register(input: AdminDataCopyRegisterInput): Promise<AdminDataCopyRegisterResult>;
  list(input: AdminDataCopyListInput): Promise<AdminDataCopyListResult>;
}

export function createAdminDataCopies(options: AdminDataCopiesOptions): AdminDataCopies {
  void options;
  throw new Error('NotImplemented: createAdminDataCopies');
}
