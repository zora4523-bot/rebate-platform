// Export generation worker (B1-34e; BR-ID-42 后台导出任务, BR-ID-33; contract CT-24k
// adminCreateExport). Handler of queue `export` (worker entry only), payload { appId, taskId } with
// taskId the internal UUID; job names:
//   - generate: claim pending → running under a per-creator advisory lock (count the creator's
//     running tasks, then CAS; at capacity the task stays pending and a delayed generate job is
//     sent in the same transaction), read the source list page by page (users through identity's
//     batch projection, masked unless the persisted task says otherwise; audit_logs through
//     B1-34a's reader with its own-records rule), write progress, enforce admin.export.max_rows
//     on the rows actually read, build one CSV (UTF-8 BOM, RFC 4180, formula guard), put it into
//     the private export store, then running → done in one transaction with expires_at =
//     generated + 24 h, the export_unmasked row-count audit of an unmasked task and the delayed
//     expire job (no singletonKey: export is a standard queue). A source / storage failure or the
//     row limit is running → failed with a short safe reason; an object whose task did not reach
//     done (cancelled meanwhile, or the done transaction rolled back) is deleted again.
//   - expire: at expires_at (injected Clock) done → expired once (CAS under the row lock) and the
//     object is deleted in that transaction; early delivery re-sends a delayed expire job; any
//     other status is ignored.
// cancelByCreator: the account-disable port, pending / running → cancelled with one audit row per
// task (export_cancel), under the same per-creator lock.
// Every status change goes through the generated transitionExportTask() (hard rule 2); time only
// from the injected Clock; logs carry ids and error class names only, never a value or message.
//
// Pure module (no decorators, erasable syntax).
import type { DB } from '@couli/db';
import { transitionExportTask, type ExportTaskState } from '@couli/domain';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import type { ExportUsersReader } from '../../identity/index.ts';
import type {
  Clock,
  ExportStore,
  JobHandler,
  JobQueue,
  ReceivedJob,
  RootLogger,
} from '../../platform/index.ts';
import type { AdminProfiles } from '../infra/admin-profiles.ts';
import { createAuditWriter } from '../infra/audit-writer.ts';
import type { AuditLogsReader, AuditQuery } from './audit-logs-read.ts';

export interface ExportWorkerOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly queue: JobQueue;
  readonly store: ExportStore;
  readonly users: ExportUsersReader;
  readonly auditLogs: AuditLogsReader;
  readonly profiles: AdminProfiles;
  readonly config: Pick<ContentReader, 'configValue'>;
  readonly logger: RootLogger;
  /** Extra audit snapshot keys to redact (the Nest assembly passes platform's SENSITIVE_KEYS). */
  readonly sensitiveKeys?: readonly string[];
}

export interface ExportWorker {
  /** export queue: generate / expire; payload { appId, taskId } (internal UUID). */
  readonly handle: JobHandler;
  /** Internal account-disable port; app-scoped, audited, pending/running only. */
  cancelByCreator(input: { readonly appId: string; readonly adminId: string }): Promise<void>;
}

export const EXPORT_QUEUE = 'export';
export const EXPORT_GENERATE_JOB = 'generate';
export const EXPORT_EXPIRE_JOB = 'expire';
export const EXPORT_MAX_ROWS_KEY = 'admin.export.max_rows';
export const EXPORT_MAX_RUNNING_KEY = 'admin.export.max_running_per_admin';
/** Code defaults (the keys are not in the configuration registry; config_items may override). */
export const EXPORT_DEFAULT_MAX_ROWS = 50_000;
export const EXPORT_DEFAULT_MAX_RUNNING = 2;
/** BR-ID-42 / BR-ID-30 ⑨: downloadable for 24 hours after generation. */
export const EXPORT_DOWNLOAD_WINDOW_MS = 86_400_000;
/** A task left pending at the creator's capacity is offered again after this delay. */
export const EXPORT_CAPACITY_RETRY_SECONDS = 15;

const USERS_PAGE_SIZE = 500;
/** The audit search's contract page_size maximum. */
const AUDIT_PAGE_SIZE = 200;
const FAILURE_REASON_MAX = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_ID = /^[a-z0-9_]{1,32}$/;
const RISK_STATES: ReadonlySet<string> = new Set(['normal', 'frozen', 'appealing', 'banned']);
const BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

const REASON_ROW_LIMIT = (max: number) => `导出行数超过上限 ${max} 行，请缩小筛选范围后重试`;
const REASON_FILTERS = '导出筛选条件无效';
const REASON_SOURCE = '读取导出数据失败，请稍后重试';
const REASON_STORAGE = '导出文件写入失败，请稍后重试';
const REASON_COMPLETE = '导出文件生成失败，请稍后重试';

type TaskRow = Selectable<DB['export_tasks']>;

interface SourcePage {
  readonly rows: readonly (readonly (string | null)[])[];
  readonly total: number;
}

interface Source {
  readonly header: readonly string[];
  readonly pageSize: number;
  page(page: number, pageSize: number): Promise<SourcePage>;
}

class SourceFiltersError extends Error {
  constructor() {
    super('export: task filters are invalid');
    this.name = 'SourceFiltersError';
  }
}

/** `instant` moved by `ms` as a new Date (no wall clock read). */
function shiftMs(instant: Date, ms: number): Date {
  const result = structuredClone(instant);
  result.setTime(instant.getTime() + ms);
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** One CSV cell: formula guard (OWASP CSV injection), then RFC 4180 quoting. */
export function csvCell(value: string | null): string {
  let text = value ?? '';
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvRecord(cells: readonly (string | null)[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

/** Positive safe integer from config_items, else the code default. */
async function limit(
  config: Pick<ContentReader, 'configValue'>,
  appId: string,
  key: string,
  fallback: number,
): Promise<number> {
  const item = await config.configValue(appId, key);
  const value = item?.value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function createExportWorker(options: ExportWorkerOptions): ExportWorker {
  const { clock, queue, store, users, auditLogs, profiles, config, logger } = options;
  const db = options.db.withSchema('app');
  const auditOn = (trx: Kysely<DB>) =>
    createAuditWriter({
      db: trx,
      clock,
      ...(options.sensitiveKeys === undefined ? {} : { sensitiveKeys: options.sensitiveKeys }),
    });

  const lockCreator = async (trx: Transaction<DB>, appId: string, adminId: string) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`admin.export_tasks.creator:${appId}:${adminId}`}, 0))`.execute(
      trx,
    );
  };

  const lockTask = (trx: Transaction<DB>, appId: string, taskId: string) =>
    trx
      .selectFrom('export_tasks')
      .selectAll()
      .where('app_id', '=', appId)
      .where('id', '=', taskId)
      .forUpdate()
      .executeTakeFirst();

  const objectKey = (task: TaskRow) => `${task.app_id}/${task.public_id}.csv`;

  async function removeObject(key: string, taskId: string): Promise<void> {
    try {
      await store.delete(key);
    } catch (error) {
      logger.warn(
        { event: 'export_object_delete_failed', task_id: taskId, key, error: errorName(error) },
        'export object could not be deleted',
      );
    }
  }

  /** pending → running when the creator has a free slot; 'deferred' when at capacity. */
  async function claim(
    appId: string,
    taskId: string,
    maxRunning: number,
  ): Promise<TaskRow | 'deferred' | null> {
    const head = await db
      .selectFrom('export_tasks')
      .select(['created_by', 'status'])
      .where('app_id', '=', appId)
      .where('id', '=', taskId)
      .executeTakeFirst();
    if (head === undefined || head.status !== 'pending') return null;
    return db.transaction().execute(async (trx) => {
      await lockCreator(trx, appId, head.created_by);
      const row = await lockTask(trx, appId, taskId);
      if (row === undefined || row.status !== 'pending') return null;
      const step = transitionExportTask(row.status as ExportTaskState, 'START');
      if (!step.ok) return null;
      const running = await trx
        .selectFrom('export_tasks')
        .select((eb) => eb.fn.countAll<bigint>().as('n'))
        .where('app_id', '=', appId)
        .where('created_by', '=', row.created_by)
        .where('status', '=', 'running')
        .executeTakeFirstOrThrow();
      if (Number(running.n) >= maxRunning) {
        await queue.send(
          EXPORT_QUEUE,
          EXPORT_GENERATE_JOB,
          { appId, taskId },
          { trx, delaySeconds: EXPORT_CAPACITY_RETRY_SECONDS },
        );
        return 'deferred';
      }
      const now = clock.now();
      const claimed = await trx
        .updateTable('export_tasks')
        .set((eb) => ({
          status: step.to,
          progress: 0,
          updated_at: now,
          row_version: eb('row_version', '+', 1),
        }))
        .where('id', '=', row.id)
        .where('status', '=', 'pending')
        .returningAll()
        .executeTakeFirst();
      return claimed ?? null;
    });
  }

  /** running → failed (CAS); a task no longer running is left as it is. */
  async function fail(task: TaskRow, reason: string): Promise<void> {
    await db.transaction().execute(async (trx) => {
      const row = await lockTask(trx, task.app_id, task.id);
      if (row === undefined || row.status !== 'running') return;
      const step = transitionExportTask(row.status as ExportTaskState, 'FAIL');
      if (!step.ok) return;
      await trx
        .updateTable('export_tasks')
        .set((eb) => ({
          status: step.to,
          failure_reason: Array.from(reason).slice(0, FAILURE_REASON_MAX).join(''),
          updated_at: clock.now(),
          row_version: eb('row_version', '+', 1),
        }))
        .where('id', '=', row.id)
        .where('status', '=', 'running')
        .execute();
    });
    logger.info({ event: 'export_failed', task_id: task.id }, 'export task failed');
  }

  /** Progress while running; false when the task is no longer running (cancelled). */
  async function progress(task: TaskRow, value: number): Promise<boolean> {
    const result = await db
      .updateTable('export_tasks')
      .set({ progress: value })
      .where('app_id', '=', task.app_id)
      .where('id', '=', task.id)
      .where('status', '=', 'running')
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async function sourceOf(task: TaskRow): Promise<Source> {
    const filters: unknown = task.filters;
    if (!isPlainObject(filters)) throw new SourceFiltersError();
    if (task.resource === 'users') {
      const risk = filters['risk_state'];
      if (risk !== undefined && (typeof risk !== 'string' || !RISK_STATES.has(risk))) {
        throw new SourceFiltersError();
      }
      const masked = task.masked;
      return {
        header: [
          'user_id',
          'nickname',
          masked ? 'phone_masked' : 'phone',
          'level',
          'risk_state',
          'created_at',
        ],
        pageSize: USERS_PAGE_SIZE,
        async page(page, pageSize) {
          const result = await users.page({
            appId: task.app_id,
            page,
            pageSize,
            masked,
            ...(risk === undefined
              ? {}
              : { riskState: risk as 'normal' | 'frozen' | 'appealing' | 'banned' }),
          });
          return {
            total: result.total,
            rows: result.items.map((row) => [
              row.user_id,
              row.nickname,
              row.phone,
              row.level,
              row.risk_state,
              row.created_at,
            ]),
          };
        },
      };
    }
    if (task.resource === 'audit_logs') {
      // Audit values are stored masked; the table's check keeps audit_logs tasks masked.
      if (!task.masked) throw new SourceFiltersError();
      const text = (key: string): string | undefined => {
        const value = filters[key];
        if (value === undefined) return undefined;
        if (typeof value !== 'string') throw new SourceFiltersError();
        return value;
      };
      const query: Omit<AuditQuery, 'page' | 'pageSize'> = {
        ...(text('actor_id') === undefined ? {} : { actorId: text('actor_id')! }),
        ...(text('target_type') === undefined ? {} : { targetType: text('target_type')! }),
        ...(text('target_id') === undefined ? {} : { targetId: text('target_id')! }),
        ...(text('permission') === undefined ? {} : { permission: text('permission')! }),
        ...(text('from') === undefined ? {} : { from: text('from')! }),
        ...(text('to') === undefined ? {} : { to: text('to')! }),
      };
      const profile = await profiles.byId(task.app_id, task.created_by);
      if (profile === undefined) throw new Error('export: the creator account is unknown');
      const caller = { appId: task.app_id, adminId: task.created_by, isSuper: profile.isSuper };
      return {
        header: [
          'id',
          'actor_id',
          'actor_name',
          'action',
          'target_type',
          'target_id',
          'permission',
          'ip',
          'at',
        ],
        pageSize: AUDIT_PAGE_SIZE,
        async page(page, pageSize) {
          const result = await auditLogs.list(caller, { ...query, page, pageSize });
          return {
            total: result.total,
            rows: result.items.map((item) => [
              item.id,
              item.actorId,
              item.actorName,
              item.action,
              item.targetType,
              item.targetId,
              item.permission,
              item.ip,
              item.at.toISOString(),
            ]),
          };
        },
      };
    }
    throw new SourceFiltersError();
  }

  /** The unmasked task's creation reason (latest export_unmasked record of the task). */
  async function unmaskedReason(trx: Transaction<DB>, task: TaskRow): Promise<string | null> {
    const row = await trx
      .selectFrom('audit_logs')
      .select('after')
      .where('app_id', '=', task.app_id)
      .where('admin_id', '=', task.created_by)
      .where('action', '=', 'export_unmasked')
      .where('target', '=', `export_tasks:${task.public_id}`)
      .orderBy('id', 'desc')
      .limit(1)
      .executeTakeFirst();
    const after: unknown = row?.after;
    return isPlainObject(after) && typeof after['reason'] === 'string' ? after['reason'] : null;
  }

  /** running → done with the expiry job, in one transaction; false when no longer running. */
  async function complete(task: TaskRow, key: string, rowCount: number): Promise<boolean> {
    return db.transaction().execute(async (trx) => {
      const row = await lockTask(trx, task.app_id, task.id);
      if (row === undefined || row.status !== 'running') return false;
      const step = transitionExportTask(row.status as ExportTaskState, 'COMPLETE');
      if (!step.ok) return false;
      const now = clock.now();
      const expiresAt = shiftMs(now, EXPORT_DOWNLOAD_WINDOW_MS);
      await trx
        .updateTable('export_tasks')
        .set((eb) => ({
          status: step.to,
          progress: 100,
          failure_reason: null,
          file_name: `${row.public_id}.csv`,
          object_key: key,
          row_count: rowCount,
          generated_at: now,
          expires_at: expiresAt,
          updated_at: now,
          row_version: eb('row_version', '+', 1),
        }))
        .where('id', '=', row.id)
        .where('status', '=', 'running')
        .execute();
      if (!row.masked) {
        await auditOn(trx).append({
          appId: row.app_id,
          actor: row.created_by,
          action: 'export_unmasked',
          target: `export_tasks:${row.public_id}`,
          before: null,
          after: {
            task_id: row.public_id,
            resource: row.resource,
            reason: await unmaskedReason(trx, row),
            row_count: rowCount,
          },
          ip: null,
        });
      }
      await queue.send(
        EXPORT_QUEUE,
        EXPORT_EXPIRE_JOB,
        { appId: row.app_id, taskId: row.id },
        {
          trx,
          delaySeconds: Math.ceil((expiresAt.getTime() - now.getTime()) / 1000),
        },
      );
      return true;
    });
  }

  async function generate(appId: string, taskId: string): Promise<void> {
    const maxRows = await limit(config, appId, EXPORT_MAX_ROWS_KEY, EXPORT_DEFAULT_MAX_ROWS);
    const maxRunning = await limit(
      config,
      appId,
      EXPORT_MAX_RUNNING_KEY,
      EXPORT_DEFAULT_MAX_RUNNING,
    );
    const task = await claim(appId, taskId, maxRunning);
    if (task === null) return;
    if (task === 'deferred') {
      logger.info({ event: 'export_deferred', task_id: taskId }, 'export task waits for a slot');
      return;
    }

    let source: Source;
    try {
      source = await sourceOf(task);
    } catch (error) {
      logger.warn(
        { event: 'export_source_failed', task_id: task.id, error: errorName(error) },
        'export source unavailable',
      );
      await fail(task, error instanceof SourceFiltersError ? REASON_FILTERS : REASON_SOURCE);
      return;
    }

    // One extra row is enough to detect the limit; the rows actually read decide, not total.
    const pageSize = Math.min(source.pageSize, maxRows + 1);
    const chunks: string[] = [csvRecord(source.header)];
    let rowCount = 0;
    let percent = 0;
    for (let page = 1; ; page++) {
      let result: SourcePage;
      try {
        result = await source.page(page, pageSize);
      } catch (error) {
        logger.warn(
          { event: 'export_source_failed', task_id: task.id, error: errorName(error) },
          'export source read failed',
        );
        await fail(task, REASON_SOURCE);
        return;
      }
      rowCount += result.rows.length;
      if (rowCount > maxRows || result.total > maxRows) {
        await fail(task, REASON_ROW_LIMIT(maxRows));
        return;
      }
      for (const cells of result.rows) chunks.push(csvRecord(cells));
      if (result.rows.length < pageSize) break;
      if (result.total > 0) {
        percent = Math.max(percent, Math.min(99, Math.floor((rowCount * 100) / result.total)));
      }
      if (!(await progress(task, percent))) return;
    }

    const key = objectKey(task);
    try {
      await store.put({
        key,
        bytes: Buffer.concat([BOM, Buffer.from(chunks.join(''), 'utf8')]),
        contentType: 'text/csv',
      });
    } catch (error) {
      logger.warn(
        { event: 'export_store_failed', task_id: task.id, error: errorName(error) },
        'export object could not be stored',
      );
      await removeObject(key, task.id);
      await fail(task, REASON_STORAGE);
      return;
    }

    let done: boolean;
    try {
      done = await complete(task, key, rowCount);
    } catch (error) {
      // Rolled back (e.g. the expiry job could not be sent): no done task, no file left behind.
      logger.warn(
        { event: 'export_complete_failed', task_id: task.id, error: errorName(error) },
        'export task could not be completed',
      );
      await removeObject(key, task.id);
      await fail(task, REASON_COMPLETE);
      return;
    }
    if (!done) {
      // Cancelled while the file was written: the file must not outlive the task.
      await removeObject(key, task.id);
      return;
    }
    logger.info({ event: 'export_done', task_id: task.id, row_count: rowCount }, 'export done');
  }

  async function expire(appId: string, taskId: string): Promise<void> {
    const outcome = await db.transaction().execute(async (trx) => {
      const row = await lockTask(trx, appId, taskId);
      if (row === undefined || row.status !== 'done' || row.expires_at === null) return 'ignored';
      const now = clock.now();
      if (now.getTime() < row.expires_at.getTime()) {
        const delaySeconds = Math.ceil((row.expires_at.getTime() - now.getTime()) / 1000);
        await queue.send(
          EXPORT_QUEUE,
          EXPORT_EXPIRE_JOB,
          { appId, taskId },
          { trx: null, delaySeconds },
        );
        return 'early';
      }
      const step = transitionExportTask(row.status as ExportTaskState, 'EXPIRE');
      if (!step.ok) return 'ignored';
      // Deleted under the row lock: a failure rolls back and the delivery is retried.
      if (row.object_key !== null) await store.delete(row.object_key);
      await trx
        .updateTable('export_tasks')
        .set((eb) => ({
          status: step.to,
          updated_at: now,
          row_version: eb('row_version', '+', 1),
        }))
        .where('id', '=', row.id)
        .where('status', '=', 'done')
        .execute();
      return 'expired';
    });
    if (outcome === 'expired') {
      logger.info({ event: 'export_expired', task_id: taskId }, 'export expired');
    }
  }

  return Object.freeze({
    async handle(job: ReceivedJob): Promise<void> {
      const appId = job.payload['appId'];
      const taskId = job.payload['taskId'];
      if (
        typeof appId !== 'string' ||
        !APP_ID.test(appId) ||
        typeof taskId !== 'string' ||
        !UUID.test(taskId)
      ) {
        logger.warn({ event: 'export_job_invalid', job_id: job.id }, 'export job payload invalid');
        return;
      }
      if (job.name === EXPORT_GENERATE_JOB) return generate(appId, taskId);
      if (job.name === EXPORT_EXPIRE_JOB) return expire(appId, taskId);
      logger.warn({ event: 'export_job_unknown', job_id: job.id }, 'export job name unknown');
    },

    async cancelByCreator(input: { readonly appId: string; readonly adminId: string }) {
      const { appId, adminId } = input;
      if (!APP_ID.test(appId) || !UUID.test(adminId)) return;
      const cancelled = await db.transaction().execute(async (trx) => {
        await lockCreator(trx, appId, adminId);
        const rows = await trx
          .selectFrom('export_tasks')
          .selectAll()
          .where('app_id', '=', appId)
          .where('created_by', '=', adminId)
          .where('status', 'in', ['pending', 'running'])
          .orderBy('created_at')
          .orderBy('id')
          .forUpdate()
          .execute();
        const audit = auditOn(trx);
        let count = 0;
        for (const row of rows) {
          const step = transitionExportTask(row.status as ExportTaskState, 'CANCEL');
          if (!step.ok) continue;
          const now = clock.now();
          await trx
            .updateTable('export_tasks')
            .set((eb) => ({
              status: step.to,
              updated_at: now,
              row_version: eb('row_version', '+', 1),
            }))
            .where('id', '=', row.id)
            .where('status', '=', row.status)
            .execute();
          await audit.append({
            appId,
            actor: adminId,
            action: 'export_cancel',
            target: `export_tasks:${row.public_id}`,
            before: { status: row.status },
            after: {
              task_id: row.public_id,
              resource: row.resource,
              status: step.to,
              cause: 'admin_disabled',
            },
            ip: null,
          });
          count++;
        }
        return count;
      });
      if (cancelled > 0) {
        logger.info({ event: 'export_cancelled', count: cancelled }, 'export tasks cancelled');
      }
    },
  });
}
