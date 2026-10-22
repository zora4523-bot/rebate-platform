// Back-office export tasks: create, list, download and retry (B1-34f; 08 BR-ID-42 后台导出任务,
// BR-ID-33; contract CT-24k adminCreateExport / adminListExports / adminDownloadExport /
// adminRetryExport). The admin operation guard (permission point export; pii.reveal_phone with its
// totp step-up for an unmasked task) runs in the controller; this use case is called inside it
// with the server-injected actor and does, per operation:
//   - create: the source list's own point (users → user.list, 10403), the request rules the schema
//     cannot express (reason only with unmasked: true, audit_logs from ≤ to; 20001), then one
//     transaction: the pending row, the export_create audit (and export_unmasked for full values)
//     and the generate job (same-transaction enqueue). No Idempotency-Key: each call is a task.
//   - list: the app's tasks, own only unless the account holds audit.view_all (or is super), read
//     now; newest first (created_at, then id); no audit, never a link or an object key.
//   - download: creator only (super and audit.view_all included); the creator's current source and
//     pii points (masked=false) are re-checked; any miss is 20001 [id] (no probing), checked before
//     the status (30417); done and before expires_at only; the link is signed for
//     min(now + 5 minutes, expires_at), then the export_download audit is written (a failing sign or
//     audit answers 50001, so no link without its record).
//   - retry: creator only (20001 [id]), failed only (30417), the source point again (10403); then
//     failed → pending through transitionExportTask under a row_version CAS, with progress and
//     failure_reason cleared, the export_retry audit (and export_unmasked with the new reason) and
//     the generate job in one transaction. A lost CAS reads the status again (30417).
// Time only from the injected Clock. Logs nothing (no value, link or token reaches a log line).
//
// Pure module (no decorators, erasable syntax).
import { randomBytes, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { transitionExportTask, type ExportTaskState } from '@couli/domain';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { AdminActor, Clock, ExportStore, JobQueue } from '../../platform/index.ts';
import type { AdminDisplayNameReader } from '../infra/admin-display-names.ts';
import type { AdminProfiles } from '../infra/admin-profiles.ts';
import { createAuditWriter } from '../infra/audit-writer.ts';
import { auditRangeInvalid } from './audit-logs-read.ts';
import { EXPORT_GENERATE_JOB, EXPORT_QUEUE } from './export-worker.ts';

export type ExportResource = 'users' | 'audit_logs';
export type ExportStatus = ExportTaskState;

/** Source list → the point the list itself needs (audit_logs: signed in is enough). */
const SOURCE_POINT: Readonly<Record<ExportResource, string | null>> = {
  users: 'user.list',
  audit_logs: null,
};
/** The pii point a full-value file is made under (the users list's only sensitive column). */
export const EXPORT_PII_POINT = 'pii.reveal_phone';
export const EXPORT_VIEW_ALL_POINT = 'audit.view_all';
/** BR-ID-42: each download link lives at most 5 minutes (and never past the task's expiry). */
export const EXPORT_LINK_TTL_MS = 300_000;

export const EXPORT_CREATE_ACTION = 'export_create';
export const EXPORT_UNMASKED_ACTION = 'export_unmasked';
export const EXPORT_DOWNLOAD_ACTION = 'export_download';
export const EXPORT_RETRY_ACTION = 'export_retry';

const RISK_STATE_NAMES: Readonly<Record<string, string>> = {
  normal: '正常',
  frozen: '冻结',
  appealing: '申诉中',
  banned: '封禁',
};
const SUMMARY_MAX = 500;

type TaskRow = Selectable<DB['export_tasks']>;

/** 20001 with data.fields. */
export class ExportFieldsError extends Error {
  readonly fields: readonly string[];
  constructor(fields: readonly string[]) {
    super(`admin export refused (${fields.join(', ')})`);
    this.name = 'ExportFieldsError';
    this.fields = fields;
  }
}

/** 10403 admin_permission_denied (the source list's point is missing). */
export class ExportPermissionError extends Error {
  constructor() {
    super('admin export: source permission missing');
    this.name = 'ExportPermissionError';
  }
}

/** 30417 with data.status. */
export class ExportStatusError extends Error {
  readonly status: ExportStatus;
  constructor(status: ExportStatus) {
    super(`admin export: status ${status} does not allow this`);
    this.name = 'ExportStatusError';
    this.status = status;
  }
}

/** The contract AdminExport (snake case, as the response carries it). */
export interface ExportView {
  readonly id: string;
  readonly resource: ExportResource;
  readonly filters_summary: string;
  readonly masked: boolean;
  readonly created_by: string;
  readonly created_by_name: string | null;
  readonly created_at: string;
  readonly status: ExportStatus;
  readonly progress: number | null;
  readonly failure_reason: string | null;
  readonly file_name: string | null;
  readonly row_count: number | null;
  readonly expires_at: string | null;
}

export interface ExportCreateCommand {
  readonly resource: ExportResource;
  /** As submitted (the contract's filter values are all strings). */
  readonly filters: Readonly<Record<string, string>>;
  readonly unmasked?: boolean;
  readonly reason?: string;
}

export interface ExportListQuery {
  readonly page: number;
  readonly pageSize: number;
  readonly status?: ExportStatus;
  readonly resource?: ExportResource;
  readonly from?: string;
  readonly to?: string;
}

export interface ExportPage {
  readonly items: readonly ExportView[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface ExportLink {
  readonly url: string;
  readonly expiresAt: Date;
}

/** A failed task of the actor, checked for retry; `reason` is required when masked is false. */
export interface RetryTarget {
  readonly task: TaskRow;
  readonly reason: string | null;
}

export interface AdminExports {
  /** Source point and request rules; throws ExportPermissionError / ExportFieldsError. */
  checkCreate(
    actor: AdminActor,
    command: ExportCreateCommand,
  ): Promise<{ readonly masked: boolean }>;
  create(actor: AdminActor, command: ExportCreateCommand, ip: string | null): Promise<ExportView>;
  list(actor: AdminActor, query: ExportListQuery): Promise<ExportPage>;
  download(actor: AdminActor, publicId: string, ip: string | null): Promise<ExportLink>;
  /** Creator, status, source point and body rules of a retry; nothing is written. */
  checkRetry(
    actor: AdminActor,
    publicId: string,
    body: { readonly reason?: string },
  ): Promise<RetryTarget>;
  retry(actor: AdminActor, target: RetryTarget, ip: string | null): Promise<ExportView>;
}

export interface AdminExportsDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly store: ExportStore;
  readonly profiles: Pick<AdminProfiles, 'permissionKeys'>;
  readonly names: AdminDisplayNameReader;
  /** Extra audit snapshot keys to redact (the Nest assembly passes platform's SENSITIVE_KEYS). */
  readonly sensitiveKeys?: readonly string[];
}

/** `instant` moved by `ms` as a new Date (no wall clock read). */
function shiftMs(instant: Date, ms: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + ms);
  return result;
}

const STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'done',
  'failed',
  'expired',
  'cancelled',
]);

function statusOf(row: TaskRow): ExportStatus {
  if (!STATUSES.has(row.status)) throw new Error('admin export: unknown task status');
  return row.status as ExportStatus;
}

function resourceOf(row: TaskRow): ExportResource {
  if (row.resource !== 'users' && row.resource !== 'audit_logs') {
    throw new Error('admin export: unknown task resource');
  }
  return row.resource;
}

/** yyyy-MM-dd HH:mm at +08:00 (display only), from an ISO 8601 instant. */
const SHANGHAI = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function displayTime(value: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  const parts = new Map(SHANGHAI.formatToParts(ms).map((part) => [part.type, part.value]));
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')} ${parts.get('hour')}:${parts.get('minute')}`;
}

/** Readable Chinese summary of the filters (written once at creation; display only). */
export function filtersSummary(
  resource: ExportResource,
  filters: Readonly<Record<string, string>>,
): string {
  const text = (key: string): string | undefined =>
    typeof filters[key] === 'string' ? filters[key] : undefined;
  let summary: string;
  if (resource === 'users') {
    const risk = text('risk_state');
    summary = `风控状态：${risk === undefined ? '全部' : (RISK_STATE_NAMES[risk] ?? risk)}`;
  } else {
    const parts: string[] = [];
    const from = text('from');
    const to = text('to');
    if (from !== undefined || to !== undefined) {
      parts.push(
        `时间：${from === undefined ? '不限' : displayTime(from)} 至 ${to === undefined ? '不限' : displayTime(to)}`,
      );
    }
    const labelled: readonly (readonly [string, string])[] = [
      ['actor_id', '操作人'],
      ['target_type', '对象类型'],
      ['target_id', '对象'],
      ['permission', '权限点'],
    ];
    for (const [key, label] of labelled) {
      const value = text(key);
      if (value !== undefined) parts.push(`${label}：${value}`);
    }
    summary = parts.length === 0 ? '时间：全部' : parts.join('；');
  }
  return Array.from(summary).slice(0, SUMMARY_MAX).join('');
}

function toView(row: TaskRow, name: string | null): ExportView {
  const status = statusOf(row);
  const finished = status === 'done' || status === 'expired';
  return {
    id: row.public_id,
    resource: resourceOf(row),
    filters_summary: row.filters_summary,
    masked: row.masked,
    created_by: row.created_by,
    created_by_name: name,
    created_at: row.created_at.toISOString(),
    status,
    // Only a running task shows its percentage (the worker stores 100 on done).
    progress: status === 'running' ? row.progress : null,
    failure_reason: status === 'failed' ? row.failure_reason : null,
    file_name: finished ? row.file_name : null,
    row_count: finished ? row.row_count : null,
    expires_at: finished && row.expires_at !== null ? row.expires_at.toISOString() : null,
  };
}

const target = (publicId: string): string => `export_tasks:${publicId}`;

export function createAdminExports(deps: AdminExportsDeps): AdminExports {
  const { clock, queue, store, profiles, names } = deps;
  const db = deps.db.withSchema('app');
  const auditOn = (trx: Kysely<DB>) =>
    createAuditWriter({
      db: trx,
      clock,
      ...(deps.sensitiveKeys === undefined ? {} : { sensitiveKeys: deps.sensitiveKeys }),
    });

  const pointsOf = async (actor: AdminActor): Promise<ReadonlySet<string>> =>
    new Set(await profiles.permissionKeys(actor.appId, actor.adminId));

  const holds = (actor: AdminActor, points: ReadonlySet<string>, point: string | null): boolean =>
    point === null || actor.isSuper || points.has(point);

  const nameOf = async (appId: string, adminId: string): Promise<string | null> =>
    (await names.displayNames(appId, [adminId])).get(adminId) ?? null;

  /** The actor's own task by its public id; another account's, another app's or none → 20001. */
  const ownTask = async (actor: AdminActor, publicId: string): Promise<TaskRow> => {
    const row = await db
      .selectFrom('export_tasks')
      .selectAll()
      .where('app_id', '=', actor.appId)
      .where('public_id', '=', publicId)
      .where('created_by', '=', actor.adminId)
      .executeTakeFirst();
    if (row === undefined) throw new ExportFieldsError(['id']);
    return row;
  };

  const enqueue = (trx: Transaction<DB>, row: TaskRow) =>
    queue.send(EXPORT_QUEUE, EXPORT_GENERATE_JOB, { appId: row.app_id, taskId: row.id }, { trx });

  return Object.freeze({
    async checkCreate(actor: AdminActor, command: ExportCreateCommand) {
      const points = await pointsOf(actor);
      if (!holds(actor, points, SOURCE_POINT[command.resource])) throw new ExportPermissionError();
      const unmasked = command.unmasked === true;
      if (command.resource === 'users') {
        // reason goes with unmasked: true only, and is required there (length by the schema).
        if (unmasked !== (command.reason !== undefined)) throw new ExportFieldsError(['reason']);
      } else {
        if (auditRangeInvalid(command.filters['from'], command.filters['to'])) {
          throw new ExportFieldsError(['from', 'to']);
        }
      }
      return { masked: !(command.resource === 'users' && unmasked) };
    },

    async create(actor: AdminActor, command: ExportCreateCommand, ip: string | null) {
      const masked = !(command.resource === 'users' && command.unmasked === true);
      const now = clock.now();
      const row = await db.transaction().execute(async (trx) => {
        const inserted = await trx
          .insertInto('export_tasks')
          .values({
            id: randomUUID(),
            app_id: actor.appId,
            public_id: `exp_${randomBytes(16).toString('base64url')}`,
            resource: command.resource,
            filters: { ...command.filters },
            filters_summary: filtersSummary(command.resource, command.filters),
            masked,
            created_by: actor.adminId,
            status: 'pending',
            progress: null,
            failure_reason: null,
            file_name: null,
            object_key: null,
            row_count: null,
            generated_at: null,
            expires_at: null,
            created_at: now,
            updated_at: now,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const audit = auditOn(trx);
        await audit.append({
          appId: actor.appId,
          actor: actor.adminId,
          action: EXPORT_CREATE_ACTION,
          target: target(inserted.public_id),
          before: null,
          after: {
            task_id: inserted.public_id,
            resource: command.resource,
            filters: { ...command.filters },
            masked,
          },
          ip,
        });
        if (!masked) {
          await audit.append({
            appId: actor.appId,
            actor: actor.adminId,
            action: EXPORT_UNMASKED_ACTION,
            target: target(inserted.public_id),
            before: null,
            after: {
              task_id: inserted.public_id,
              resource: command.resource,
              reason: command.reason ?? null,
            },
            ip,
          });
        }
        await enqueue(trx, inserted);
        return inserted;
      });
      return toView(row, await nameOf(actor.appId, actor.adminId));
    },

    async list(actor: AdminActor, query: ExportListQuery) {
      if (auditRangeInvalid(query.from, query.to)) throw new ExportFieldsError(['from', 'to']);
      const points = await pointsOf(actor);
      const all = actor.isSuper || points.has(EXPORT_VIEW_ALL_POINT);
      let base = db.selectFrom('export_tasks').where('app_id', '=', actor.appId);
      if (!all) base = base.where('created_by', '=', actor.adminId);
      if (query.status !== undefined) base = base.where('status', '=', query.status);
      if (query.resource !== undefined) base = base.where('resource', '=', query.resource);
      if (query.from !== undefined) {
        base = base.where('created_at', '>=', sql<Date>`${query.from}::timestamptz`);
      }
      if (query.to !== undefined) {
        base = base.where('created_at', '<', sql<Date>`${query.to}::timestamptz`);
      }
      const counted = await base
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      const rows = await base
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute();
      const display = await names.displayNames(
        actor.appId,
        rows.map((row) => row.created_by),
      );
      return {
        items: rows.map((row) => toView(row, display.get(row.created_by) ?? null)),
        page: query.page,
        pageSize: query.pageSize,
        total: Number(counted.n),
      };
    },

    async download(actor: AdminActor, publicId: string, ip: string | null) {
      const row = await ownTask(actor, publicId);
      const points = await pointsOf(actor);
      const resource = resourceOf(row);
      // A creator who lost the source point or the pii point of a full-value file: no probing.
      if (
        !holds(actor, points, SOURCE_POINT[resource]) ||
        (!row.masked && !holds(actor, points, EXPORT_PII_POINT))
      ) {
        throw new ExportFieldsError(['id']);
      }
      const status = statusOf(row);
      if (status !== 'done') throw new ExportStatusError(status);
      const now = clock.now();
      const key = row.object_key;
      if (row.expires_at === null || row.expires_at.getTime() <= now.getTime()) {
        throw new ExportStatusError('expired');
      }
      if (key === null) throw new Error('admin export: done task without an object key');
      const expiresAt = shiftMs(
        now,
        Math.min(EXPORT_LINK_TTL_MS, row.expires_at.getTime() - now.getTime()),
      );
      const link = await store.signedUrl({ key, expiresAt });
      // Written and awaited before the link leaves; a failing write answers 50001 without it.
      await auditOn(db).append({
        appId: actor.appId,
        actor: actor.adminId,
        action: EXPORT_DOWNLOAD_ACTION,
        target: target(row.public_id),
        before: null,
        after: { task_id: row.public_id, resource, masked: row.masked },
        ip,
      });
      return { url: link.url, expiresAt: link.expiresAt };
    },

    async checkRetry(actor: AdminActor, publicId: string, body: { readonly reason?: string }) {
      const row = await ownTask(actor, publicId);
      const status = statusOf(row);
      if (status !== 'failed') throw new ExportStatusError(status);
      const points = await pointsOf(actor);
      if (!holds(actor, points, SOURCE_POINT[resourceOf(row)])) throw new ExportPermissionError();
      // A full-value task needs a new reason; a masked one takes none.
      if (row.masked === (body.reason !== undefined)) throw new ExportFieldsError(['reason']);
      return { task: row, reason: body.reason ?? null };
    },

    async retry(actor: AdminActor, retryTarget: RetryTarget, ip: string | null) {
      const { task } = retryTarget;
      const step = transitionExportTask(statusOf(task), 'RETRY');
      if (!step.ok) throw new ExportStatusError(statusOf(task));
      const outcome = await db.transaction().execute(async (trx) => {
        const now = clock.now();
        const updated = await trx
          .updateTable('export_tasks')
          .set({
            status: step.to,
            progress: null,
            failure_reason: null,
            updated_at: now,
            row_version: task.row_version + 1,
          })
          .where('app_id', '=', task.app_id)
          .where('id', '=', task.id)
          .where('created_by', '=', actor.adminId)
          .where('status', '=', task.status)
          .where('row_version', '=', task.row_version)
          .returningAll()
          .executeTakeFirst();
        if (updated === undefined) return undefined;
        const audit = auditOn(trx);
        await audit.append({
          appId: actor.appId,
          actor: actor.adminId,
          action: EXPORT_RETRY_ACTION,
          target: target(updated.public_id),
          before: { status: task.status },
          after: { task_id: updated.public_id, resource: updated.resource, masked: updated.masked },
          ip,
        });
        if (!updated.masked) {
          await audit.append({
            appId: actor.appId,
            actor: actor.adminId,
            action: EXPORT_UNMASKED_ACTION,
            target: target(updated.public_id),
            before: null,
            after: {
              task_id: updated.public_id,
              resource: updated.resource,
              reason: retryTarget.reason,
            },
            ip,
          });
        }
        await enqueue(trx, updated);
        return updated;
      });
      if (outcome === undefined) {
        // Lost the CAS (a concurrent retry, or the task changed meanwhile): report it as it is now.
        const current = await ownTask(actor, task.public_id);
        throw new ExportStatusError(statusOf(current));
      }
      return toView(outcome, await nameOf(actor.appId, actor.adminId));
    },
  });
}
