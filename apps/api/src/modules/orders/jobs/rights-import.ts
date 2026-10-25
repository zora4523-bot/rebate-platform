// B1-09g: the rights_import job on orders' order-sync queue (payload { app_id, import_id }; sent by
// application/rights-imports.ts). The worker's order-sync handler routes job name 'rights_import'
// here (worker-runtime.ts), next to 'window' and the snapshot retry.
//   ① the task row of (app_id, import_id): missing → nothing to do; already done / failed → nothing
//      to do (a redelivered job never processes a row twice); still running → a redelivery after a
//      crashed attempt, resumed as in ⑥;
//   ② status running is committed before the first row;
//   ③ the file is read back from the import store and its first sheet parsed (first row = header);
//      the template of (kind, platform) maps the columns (application/rights-import-ports.ts):
//      no template, or a template column missing from the header → every data row invalid_row;
//      otherwise each data row goes, in file order, to the processor of the task's kind;
//   ④ each row's outcome is committed before the next row goes to the processor: one transaction
//      per row (B1-09h) locks the task row at the checkpoint, is handed to the processor (whose
//      writes ride on it), inserts the row's failure into rights_import_failures (row_no, reason;
//      insert-only, one per (import_id, row_no)) and adds it to the tallies (domain
//      countRightsImportRows), so the committed tallies are the checkpoint; status done with
//      finished_at (the injected Clock) at the end;
//   ⑤ the whole task fails (status failed, finished_at) when its file is gone or cannot be read, or
//      no processor is injected for its kind (J-22; logged at error with ids only);
//   ⑥ an error thrown by a processor (or the database) is not swallowed: the attempt fails, the
//      task stays running and the queue redelivers. The redelivered job resumes at the first row
//      whose outcome is not committed: committed rows are never sent again (no (import_id, row_no)
//      conflict, no row of this task re-counted as duplicate); the row in flight at the crash is
//      sent again. The end state equals that of an uninterrupted run.
// Logs carry ids, kinds and counts only, never a cell, the filename or the bytes.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, ImportStore, ReceivedJob, RootLogger } from '../../platform/index.ts';
import type {
  RightsImportCell,
  RightsImportProcessors,
  RightsImportRow,
  RightsImportRowProcessor,
  RightsImportTaskInfo,
  RightsImportTemplates,
} from '../application/rights-import-ports.ts';
import {
  countRightsImportRows,
  type RightsImportKind,
  type RightsImportRowOutcome,
  type RightsImportTimeBasis,
} from '../domain/rights-import.ts';
import { readRightsImportSheet, type RightsImportSheet } from '../infra/rights-import-sheet.ts';
import {
  commitRightsImportRow,
  findRightsImport,
  finishRightsImport,
  lockRightsImportCheckpoint,
  markRightsImportRunning,
  type RightsImportRecord,
} from '../infra/rights-import-store.ts';

/** The job name inside the order-sync queue (platform/queue job name rule: lower case, `_`). */
export type RightsImportJobName = 'rights_import';

export interface RightsImportJobDeps {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly store: ImportStore;
  readonly templates: RightsImportTemplates;
  readonly processors: RightsImportProcessors;
  readonly logger: RootLogger;
}

export class RightsImportPayloadError extends Error {
  override readonly name = 'RightsImportPayloadError';
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parsePayload(payload: ReceivedJob['payload']): { appId: string; importId: string } {
  const appId = payload['app_id'];
  const importId = payload['import_id'];
  if (typeof appId !== 'string' || appId === '') throw new RightsImportPayloadError('app_id');
  if (typeof importId !== 'string' || !UUID.test(importId)) {
    throw new RightsImportPayloadError('import_id');
  }
  return { appId, importId };
}

function taskInfo(row: RightsImportRecord): RightsImportTaskInfo {
  return {
    import_id: row.id,
    app_id: row.app_id,
    kind: row.kind as RightsImportKind,
    platform: row.platform,
    union_account_id: row.union_account_id,
    time_basis: row.time_basis as RightsImportTimeBasis | null,
    from: row.from,
    to: row.to,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

const headerText = (cell: RightsImportCell): string | null =>
  typeof cell === 'string' ? cell.trim() : typeof cell === 'number' ? String(cell) : null;

/**
 * Template column → index in the file's header; null when nothing is registered for (kind,
 * platform) or a template column is missing from the header.
 */
function columnsOf(
  templates: RightsImportTemplates,
  task: RightsImportTaskInfo,
  sheet: RightsImportSheet,
): ReadonlyMap<string, number> | null {
  const template = templates.find(task.kind, task.platform);
  if (template === undefined) return null;
  const header = sheet.header.map(headerText);
  const columns = new Map<string, number>();
  for (const [name, text] of Object.entries(template.columns)) {
    const index = header.indexOf(text.trim());
    if (index < 0) return null;
    columns.set(name, index);
  }
  return columns;
}

const INVALID_ROW: RightsImportRowOutcome = { kind: 'failed', reason: 'invalid_row' };

/** A malformed payload throws (the queue retries, then dead-letters); see the header for the rest. */
export async function handleRightsImport(
  job: ReceivedJob,
  deps: RightsImportJobDeps,
): Promise<void> {
  const { appId, importId } = parsePayload(job.payload);
  const { db, clock, logger } = deps;
  const log = { app_id: appId, import_id: importId, job_id: job.id, attempt: job.attempt };
  let row = await findRightsImport(db, appId, importId);
  if (row === undefined || row.status === 'done' || row.status === 'failed') return;
  if (row.status === 'queued') {
    await markRightsImportRunning(db, appId, importId);
    row = await findRightsImport(db, appId, importId);
    if (row?.status !== 'running') return;
  }
  const task = taskInfo(row);
  const fail = async (reason: string): Promise<void> => {
    await finishRightsImport(db, appId, importId, 'failed', clock.now());
    logger.error(
      { event: 'rights_import_failed', ...log, kind: task.kind, reason },
      'rights import failed',
    );
  };

  const processor: RightsImportRowProcessor | undefined = deps.processors[task.kind];
  if (processor === undefined) return fail('no_processor');
  const bytes = await deps.store.get(row.file_path);
  if (bytes === null) return fail('file_missing');
  const sheet = await readRightsImportSheet(bytes);
  if (sheet === null) return fail('file_unreadable');
  const columns = columnsOf(deps.templates, task, sheet);

  // The committed tallies are the checkpoint: rows are committed in file order, one per row.
  let committed = row.total_rows;
  for (const data of sheet.rows.slice(committed)) {
    // One transaction per row: the processor writes on it and the row's checkpoint commits on it,
    // so a crash before COMMIT leaves nothing of the row and the redelivered row counts once.
    await db.transaction().execute(async (trx) => {
      if (!(await lockRightsImportCheckpoint(trx, appId, importId, committed))) {
        throw new Error('orders: rights import checkpoint moved; this attempt stops');
      }
      let outcome: RightsImportRowOutcome;
      if (columns === null) {
        outcome = INVALID_ROW;
      } else {
        const values: Record<string, RightsImportCell> = {};
        for (const [name, index] of columns) values[name] = data.cells[index] ?? null;
        const input: RightsImportRow = { row_no: data.row_no, values };
        outcome = await processor.process(task, input, trx);
      }
      await commitRightsImportRow(trx, {
        appId,
        importId,
        committed,
        rowNo: data.row_no,
        failure: outcome.kind === 'failed' ? outcome.reason : null,
        add: countRightsImportRows([outcome]),
      });
    });
    committed += 1;
  }
  await finishRightsImport(db, appId, importId, 'done', clock.now());
  logger.info(
    {
      event: 'rights_import_done',
      ...log,
      kind: task.kind,
      rows: committed,
      template: columns !== null,
    },
    'rights import done',
  );
}
