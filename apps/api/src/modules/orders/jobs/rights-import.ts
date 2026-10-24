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
//      inserts its failure into rights_import_failures (row_no, reason; insert-only, one per
//      (import_id, row_no)) and adds it to the tallies (domain countRightsImportRows), so the
//      committed tallies are the checkpoint; status done with finished_at (the injected Clock) at
//      the end;
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
  RightsImportProcessors,
  RightsImportTemplates,
} from '../application/rights-import-ports.ts';

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

/** A malformed payload throws (the queue retries, then dead-letters); see the header for the rest. */
export function handleRightsImport(job: ReceivedJob, deps: RightsImportJobDeps): Promise<void> {
  void job;
  void deps;
  throw new Error('NotImplemented: handleRightsImport');
}
