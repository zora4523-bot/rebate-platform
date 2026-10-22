import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { ContentReader } from '../../content/index.ts';
import type { ExportUsersReader } from '../../identity/index.ts';
import type { Clock, ExportStore, RootLogger, JobHandler, JobQueue } from '../../platform/index.ts';
import type { AdminProfiles } from '../infra/admin-profiles.ts';
import type { AuditLogsReader } from './audit-logs-read.ts';

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
}

export interface ExportWorker {
  /** export queue: generate / expire; payload { appId, taskId } (internal UUID). */
  readonly handle: JobHandler;
  /** Internal account-disable port; app-scoped, audited, pending/running only. */
  cancelByCreator(input: { readonly appId: string; readonly adminId: string }): Promise<void>;
}

export function createExportWorker(options: ExportWorkerOptions): ExportWorker {
  void options;
  throw new Error('NotImplemented: createExportWorker');
}
