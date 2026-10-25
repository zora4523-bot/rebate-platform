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
// One transaction per registration: the users row locked FOR NO KEY UPDATE (the deletion cleanup
// and the processing step take the same lock before they change the account), so the stage, the
// unfinished request and the latest ended request are read fresh and two registrations of one user
// run one after the other; a 23505 on personal_data_copies_open_key (a writer that does not take
// the user lock) reruns the whole registration once, which then returns the request that won.
// Refusals after the user check commit their audit record on the same transaction (with a
// registrant-lost request failed before them, its user_data_copy_fail record included); an unknown
// user writes nothing (no other app's id in this app's audit). The audit keys avoid the redacted
// fragments (phone / token / secret ...): the SMS channel fact is `sms_ok`.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types.
import { randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { AuditPort, Clock, JobQueue, RootLogger } from '../../platform/index.ts';
import { resolveWorkingDayDeadline } from '../../risk/index.ts';
import {
  DATA_COPY_AUDIT_FAIL,
  DATA_COPY_OPEN_STATUSES,
  dataCopyAuditTarget,
} from '../infra/personal-data-copies.ts';
import { createDeletionStageReader } from '../ports/deletion-stage.ts';
import { DATA_COPY_GENERATE_JOB, DATA_COPY_QUEUE } from './data-copy-worker.ts';
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

/** Nest token of the use case (IdentityAdminModule). */
export const ADMIN_DATA_COPIES = Symbol('ADMIN_DATA_COPIES');
/** The audit action of every registration past the permission, step-up and body checks. */
export const DATA_COPY_AUDIT_REQUEST = 'user_data_copy_request';
/** BR-ID-40 细则「截止时刻」: the 15th working day after the registration date (BR-ID-27). */
export const DATA_COPY_DUE_WORKING_DAYS = 15;
/** failure_reason of a wecom_session request whose registrant can no longer download it. */
export const DATA_COPY_REASON_REGISTRANT_LOST = '登记人已停用或不再持有下载权限，已由重新登记取代';

const OPEN_KEY = 'personal_data_copies_open_key';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CopyRow = Selectable<DB['personal_data_copies']>;
type Refusal = Exclude<AdminDataCopyRegisterResult, { kind: 'registered' | 'unknown_user' }>;

/** The refusal code each refusal is recorded under (contract adminCreateUserDataExport). */
const REFUSAL_CODE: Readonly<Record<Refusal['kind'], number>> = {
  account_deleting: 30419,
  account_deleted: 30419,
  delivery_undecided: 30419,
  phone_missing: 20001,
  permission_denied: 10403,
};

function uniqueViolationOf(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const pg = error as { code?: unknown; constraint?: unknown };
  return pg.code === '23505' && pg.constraint === constraint;
}

function viewOf(row: CopyRow, names: ReadonlyMap<string, string>): AdminDataCopyView {
  return {
    exportId: row.id,
    userId: row.user_id,
    delivery: row.delivery as AdminDataCopyDelivery,
    status: row.status as AdminDataCopyStatus,
    requestedBy: row.requested_by,
    requestedByName: names.get(row.requested_by) ?? null,
    createdAt: row.created_at,
    dueAt: row.due_at,
    retryOf: row.retry_of,
    generatedAt: row.generated_at,
    deliveredAt: row.delivered_at,
    expiresAt: row.expires_at,
    failureReason: row.failure_reason,
  };
}

/** The ended request a new one replaces: failed, or a wecom_session one expired undelivered. */
function replaces(latest: CopyRow | undefined): latest is CopyRow {
  if (latest === undefined) return false;
  if (latest.status === 'failed') return true;
  return (
    latest.status === 'expired' &&
    latest.delivery === 'wecom_session' &&
    latest.delivered_at === null
  );
}

export function createAdminDataCopies(options: AdminDataCopiesOptions): AdminDataCopies {
  const { db, clock, logger, queue, calendar, registrants, auditOn } = options;
  const stages = createDeletionStageReader({ db });

  const requestAudit = (
    trx: Transaction<DB>,
    input: AdminDataCopyRegisterInput,
    target: string,
    result: Readonly<Record<string, string | number | boolean | null>>,
  ) =>
    auditOn(trx).append({
      appId: input.appId,
      actor: input.adminId,
      action: DATA_COPY_AUDIT_REQUEST,
      target,
      before: null,
      after: {
        user_id: input.userId,
        reason: input.reason,
        app_login_ok: input.appLoginOk,
        sms_ok: input.phoneSmsOk,
        ...result,
      },
      ip: input.ip,
    });

  async function names(handle: Kysely<DB>, appId: string, ids: readonly string[]) {
    try {
      return await registrants.names(handle, appId, ids);
    } catch (error) {
      // The name is display only: an unreadable one is null (contract), the request still answers.
      logger.warn(
        { app_id: appId, error_name: error instanceof Error ? error.name : typeof error },
        'identity_data_copy_registrant_names_failed',
      );
      return new Map<string, string>();
    }
  }

  async function registerOn(
    trx: Transaction<DB>,
    input: AdminDataCopyRegisterInput,
  ): Promise<AdminDataCopyRegisterResult> {
    const app = trx.withSchema('app');
    const user = await app
      .selectFrom('users')
      .select(['id', 'phone_cipher'])
      .where('app_id', '=', input.appId)
      .where('id', '=', input.userId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (user === undefined) return { kind: 'unknown_user' };
    const now = clock.now();

    const refuse = async (refusal: Refusal): Promise<AdminDataCopyRegisterResult> => {
      await requestAudit(trx, input, `users:${input.userId}`, {
        result: 'refused',
        code: REFUSAL_CODE[refusal.kind],
        refusal: refusal.kind,
      });
      return refusal;
    };

    // 1. The account's deletion (cooling is accepted).
    const stage =
      (await stages.read(trx, { appId: input.appId, userIds: [input.userId] })).get(input.userId) ??
      'none';
    if (stage === 'processing') return refuse({ kind: 'account_deleting' });
    if (stage === 'done') return refuse({ kind: 'account_deleted' });

    // 2. The unfinished request (at most one, personal_data_copies_open_key).
    const open = await app
      .selectFrom('personal_data_copies')
      .selectAll()
      .where('app_id', '=', input.appId)
      .where('user_id', '=', input.userId)
      .where('status', 'in', [...DATA_COPY_OPEN_STATUSES])
      .forUpdate()
      .executeTakeFirst();
    let replaced: CopyRow | undefined;
    if (open !== undefined) {
      const lost =
        open.delivery === 'wecom_session' &&
        !(await registrants.canDownload(trx, input.appId, open.requested_by));
      if (!lost) {
        await requestAudit(trx, input, dataCopyAuditTarget(open.id), {
          result: 'reused',
          copy_id: open.id,
        });
        const shown = await names(trx, input.appId, [open.requested_by]);
        return { kind: 'registered', view: viewOf(open, shown), reused: true };
      }
      // The registrant can no longer download it: failed now, replaced below (BR-ID-40 细则).
      const failed = await app
        .updateTable('personal_data_copies')
        .set({
          status: 'failed',
          failure_reason: DATA_COPY_REASON_REGISTRANT_LOST,
          updated_at: now,
          row_version: open.row_version + 1,
        })
        .where('app_id', '=', input.appId)
        .where('id', '=', open.id)
        .where('status', '=', open.status)
        .where('row_version', '=', open.row_version)
        .executeTakeFirst();
      if (failed.numUpdatedRows !== 1n) {
        throw new Error('identity: the unfinished copy request changed under its row lock');
      }
      await auditOn(trx).append({
        appId: input.appId,
        actor: input.adminId,
        action: DATA_COPY_AUDIT_FAIL,
        target: dataCopyAuditTarget(open.id),
        before: { status: open.status },
        after: {
          copy_id: open.id,
          user_id: open.user_id,
          delivery: open.delivery,
          status: 'failed',
          cause: 'registrant_lost',
          registrant_id: open.requested_by,
        },
        ip: input.ip,
      });
      replaced = open;
    }

    // 3. The delivery from the two channel facts.
    let delivery: AdminDataCopyDelivery;
    if (input.appLoginOk && input.phoneSmsOk) {
      if (user.phone_cipher === null) return refuse({ kind: 'phone_missing' });
      delivery = 'in_app_sms';
    } else if (!input.appLoginOk && !input.phoneSmsOk) {
      if (!(await registrants.canDownload(trx, input.appId, input.adminId))) {
        return refuse({ kind: 'permission_denied' });
      }
      delivery = 'wecom_session';
    } else {
      return refuse({ kind: 'delivery_undecided' });
    }

    // retry_of and due_at: the request failed just above, else the user's latest request when it
    // is failed or a wecom_session one expired undelivered (every request has ended here).
    const latest =
      replaced ??
      (await app
        .selectFrom('personal_data_copies')
        .selectAll()
        .where('app_id', '=', input.appId)
        .where('user_id', '=', input.userId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst());
    const previous = replaced ?? (replaces(latest) ? latest : undefined);
    const dueAt =
      previous === undefined
        ? await resolveWorkingDayDeadline({
            appId: input.appId,
            from: now,
            workingDays: DATA_COPY_DUE_WORKING_DAYS,
            config: calendar,
            logger,
          })
        : previous.due_at;

    const row = await app
      .insertInto('personal_data_copies')
      .values({
        id: randomUUID(),
        app_id: input.appId,
        user_id: input.userId,
        requested_by: input.adminId,
        delivery,
        status: 'pending',
        retry_of: previous?.id ?? null,
        object_key: null,
        due_at: dueAt,
        generated_at: null,
        delivered_at: null,
        expires_at: null,
        failure_reason: null,
        row_version: 0,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    // Same-transaction enqueue (B1-27h's generate job); a failing send rolls the request back.
    await queue.send(
      DATA_COPY_QUEUE,
      DATA_COPY_GENERATE_JOB,
      { appId: row.app_id, copyId: row.id },
      { trx },
    );
    await requestAudit(trx, input, dataCopyAuditTarget(row.id), {
      result: 'created',
      copy_id: row.id,
      delivery,
      retry_of: row.retry_of,
    });
    const shown = await names(trx, input.appId, [row.requested_by]);
    return { kind: 'registered', view: viewOf(row, shown), reused: false };
  }

  async function register(input: AdminDataCopyRegisterInput): Promise<AdminDataCopyRegisterResult> {
    if (!UUID.test(input.userId)) return { kind: 'unknown_user' };
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await db.transaction().execute((trx) => registerOn(trx, input));
      } catch (error) {
        // A concurrent writer created the unfinished request first: run again, which returns it.
        if (attempt === 0 && uniqueViolationOf(error, OPEN_KEY)) continue;
        throw error;
      }
    }
  }

  async function list(input: AdminDataCopyListInput): Promise<AdminDataCopyListResult> {
    if (!UUID.test(input.userId)) return { kind: 'unknown_user' };
    const app = db.withSchema('app');
    const user = await app
      .selectFrom('users')
      .select('id')
      .where('app_id', '=', input.appId)
      .where('id', '=', input.userId)
      .executeTakeFirst();
    if (user === undefined) return { kind: 'unknown_user' };
    const mine = app
      .selectFrom('personal_data_copies')
      .where('app_id', '=', input.appId)
      .where('user_id', '=', input.userId);
    const counted = await mine
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    const rows = await mine
      .selectAll()
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize)
      .execute();
    const shown = await names(db, input.appId, [...new Set(rows.map((row) => row.requested_by))]);
    return {
      kind: 'page',
      items: rows.map((row) => viewOf(row, shown)),
      total: Number(counted.n),
    };
  }

  return Object.freeze({ register, list });
}
