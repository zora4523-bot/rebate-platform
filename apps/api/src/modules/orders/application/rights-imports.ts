// B1-09g: the admin Excel import tasks (contract adminCreateRightsImport / adminListRightsImports /
// adminGetRightsImport; 04 §3.2 rights_imports / rights_import_failures; 08 BR-FUND-06 细则
// 「维权导入任务」, BR-ATTR-26 细则「渠道单导入」). The routes stay planned and unmounted (J-1 / J-22):
// mounting is B1-09n. Permissions and the channel step-up are the HTTP layer's
// (http/admin/rights-imports.http.ts); these use cases get an authorised actor.
//
// createRightsImport, in this order:
//   ① the form (domain/rights-import.ts checkRightsImportForm) → 20001 data.fields; a channel
//      import's union_account_id must name a union account of the actor's app → else
//      20001 [union_account_id];
//   ② the file: absent, not an xlsx, unreadable, or more than 10,000 data rows under the header row
//      → 20001 [file]. Nothing is stored or written for a refused request;
//   ③ every accepted upload is a new task (no deduplication by file or content, BR-FUND-06): a new
//      import_id (UUIDv7), the bytes put into the private import store under
//      `<app_id>/<import_id>.xlsx` (rights_imports.file_path), then one transaction: the
//      rights_imports row (status queued, created_by the actor, created_at the injected Clock), one
//      audit record for the whole file (action rights_import_create, target
//      `rights_imports:<import_id>`, after: kind, platform, filename, total_rows) and the job, sent
//      on that transaction: queue `order-sync` (orders' own queue, exclusive: singletonKey
//      `rights_import:<import_id>`), job name `rights_import`, payload { app_id, import_id } (never
//      the file, its name or its cells);
//   ④ answer { import_id, status: queued }.
// Logs carry ids and counts only, never the filename or any cell.
//
// listRightsImports / getRightsImport: rows of the app only, created_at descending (then id), the
// five tallies, created_by and created_by_name (display_name, else login_name); the detail adds every
// row failure ordered by row_no. An import_id that is not a UUID, unknown, or of another app is
// 20001 [import_id]. Reading writes no audit.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { AuditPort, Clock, ImportStore, JobQueue, RootLogger } from '../../platform/index.ts';
import type { RightsImportFormFields } from '../domain/rights-import.ts';

export type RightsImportAuditAction = 'rights_import_create';

export interface RightsImportActor {
  readonly appId: string;
  readonly adminId: string;
  readonly ip: string | null;
}

/** The file part as read from the multipart body. */
export interface RightsImportUpload {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimetype: string;
}

export interface RightsImportCommand extends RightsImportFormFields {
  /** Absent → 20001 [file]. */
  readonly file?: RightsImportUpload | undefined;
}

export interface RightsImportDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly store: ImportStore;
  readonly queue: JobQueue;
  /** admin's audit writer bound to the task's transaction. */
  readonly auditOn: (trx: Transaction<DB>) => AuditPort;
  readonly logger: RootLogger;
}

export type RightsImportFieldsError = {
  readonly code: 20001;
  readonly data: { readonly fields: readonly string[] };
};

export type RightsImportCreateOutcome =
  | { readonly code: 0; readonly data: Schema<'AdminRightsImportCreated'> }
  | RightsImportFieldsError;

export interface RightsImportPageQuery {
  /** From 1; a page past the last one has no items. */
  readonly page: number;
  /** 1..200 (the route schema refuses more). */
  readonly page_size: number;
}

export type RightsImportDetailOutcome =
  | { readonly code: 0; readonly data: Schema<'AdminRightsImportDetail'> }
  | RightsImportFieldsError;

/** Operational failures (store, database, queue) propagate; nothing is answered for them. */
export function createRightsImport(
  deps: RightsImportDeps,
  actor: RightsImportActor,
  command: RightsImportCommand,
): Promise<RightsImportCreateOutcome> {
  void deps;
  void actor;
  void command;
  throw new Error('NotImplemented: createRightsImport');
}

export function listRightsImports(
  deps: Pick<RightsImportDeps, 'db'>,
  appId: string,
  query: RightsImportPageQuery,
): Promise<Schema<'AdminRightsImportPage'>> {
  void deps;
  void appId;
  void query;
  throw new Error('NotImplemented: listRightsImports');
}

export function getRightsImport(
  deps: Pick<RightsImportDeps, 'db'>,
  appId: string,
  importId: string,
): Promise<RightsImportDetailOutcome> {
  void deps;
  void appId;
  void importId;
  throw new Error('NotImplemented: getRightsImport');
}
