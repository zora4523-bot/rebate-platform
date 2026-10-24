// B1-09g: what the rights_import job hands to the per-kind row processors, and the column template
// registry it reads (08 BR-FUND-06 细则「维权导入任务」, BR-ATTR-26 细则「渠道单导入」). Types only.
//
// Row processors (one per kind; injected by the assembly):
//   - rights / punish: B1-09k (locate the sub-order, the five row failures, the time window,
//     rights.record into order_rights; duplicate under the BR-FUND-06 key);
//   - channel: B1-09h (risk's channel blocklist port; start_at = the task's created_at).
// A processor owns its own transaction(s) and returns one outcome per row; it never writes
// rights_imports or rights_import_failures (the job does: failures insert-only, the five tallies).
// A kind without an injected processor ends the whole task as failed (J-22), no row is processed.
//
// Column templates: the columns of each Excel type follow the union's official export template,
// registered by the contract line (待验证 until tested). The job reads the file's first row as the
// header and maps each template column to the cell under the header text the template names
// (exact text after trimming). No template registered for (kind, platform), or a template column
// missing from the header: every data row of the file is the row failure invalid_row and no row
// reaches the processor. Rows are numbered as in the file (the header is row 1).
import type {
  RightsImportKind,
  RightsImportRowOutcome,
  RightsImportTimeBasis,
} from '../domain/rights-import.ts';

/** One cell as read from the xlsx; empty cells are null. */
export type RightsImportCell = string | number | boolean | Date | null;

/** One data row: its number in the file and the template columns' cells. */
export interface RightsImportRow {
  readonly row_no: number;
  /** Template column name → cell (null when the cell is empty). */
  readonly values: Readonly<Record<string, RightsImportCell>>;
}

/** The task a row belongs to, as stored in rights_imports. */
export interface RightsImportTaskInfo {
  readonly import_id: string;
  readonly app_id: string;
  readonly kind: RightsImportKind;
  readonly platform: string;
  /** channel only. */
  readonly union_account_id: string | null;
  readonly time_basis: RightsImportTimeBasis | null;
  readonly from: Date | null;
  readonly to: Date | null;
  readonly created_by: string;
  /** The acceptance time of the upload (channel: every blocklist entry's start_at). */
  readonly created_at: Date;
}

export interface RightsImportRowProcessor {
  process(task: RightsImportTaskInfo, row: RightsImportRow): Promise<RightsImportRowOutcome>;
}

export type RightsImportProcessors = Readonly<
  Partial<Record<RightsImportKind, RightsImportRowProcessor>>
>;

/** One registered Excel layout: template column name → header text in the file. */
export interface RightsImportTemplate {
  readonly columns: Readonly<Record<string, string>>;
}

export interface RightsImportTemplates {
  /** undefined: nothing registered for (kind, platform) yet. */
  find(kind: RightsImportKind, platform: string): RightsImportTemplate | undefined;
}
