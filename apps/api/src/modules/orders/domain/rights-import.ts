// B1-09g: the form of POST /admin/v1/rights-imports (contract adminCreateRightsImport,
// AdminRightsImportByOrder / AdminRightsImportChannel; 08 BR-FUND-06 细则「维权导入任务」,
// BR-ATTR-26 细则「渠道单导入」) and the five tallies of an import task. Pure: no Nest, no data access.
// Enumerations are contracts/enums/order.yaml (CT-24n): rights_import_kind, rights_import_status,
// rights_import_time_basis, rights_import_failure_reason.
//
// checkRightsImportForm judges the text parts as sent (undefined = part absent), each refusal naming
// the one field of the contract's 20001 data.fields:
//   - kind outside rights / punish / channel (or absent) → [kind]; platform outside the platform
//     enum (or absent) → [platform];
//   - rights / punish: a window needs both ends and time_basis — from or to without time_basis →
//     [time_basis]; one end without the other names the missing [from] / [to]; an end that is not an
//     ISO 8601 instant with offset names itself; from not before to is refused (rights_imports
//     window check). time_basis outside paid / received → [time_basis]; time_basis alone is
//     accepted and ignored (no window, no filtering). union_account_id is not a part of these kinds
//     → [union_account_id];
//   - channel: union_account_id required (a UUID) → [union_account_id]; any of time_basis, from,
//     to → that field.
// The file part is judged by the use case (application/rights-imports.ts), not here.
// TODO(规划/11 §4.5): Excel column templates per (kind, platform) — blocked on the owner's samples
// (K-3); until registered, rights / punish rows are invalid_row (application/rights-import-ports.ts).
import type { Schema } from '@couli/contracts-ts';

export type RightsImportKind = Schema<'AdminRightsImportKind'>;
export type RightsImportStatus = Schema<'AdminRightsImportStatus'>;
export type RightsImportTimeBasis = Schema<'AdminRightsImportTimeBasis'>;
export type RightsImportFailureReason = Schema<'AdminRightsImportFailureReason'>;
export type RightsImportPlatform = Schema<'PlatformCode'>;

/** The text parts of the multipart form as sent; undefined = the part is absent. */
export interface RightsImportFormFields {
  readonly kind?: string | undefined;
  readonly platform?: string | undefined;
  readonly time_basis?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly union_account_id?: string | undefined;
}

/** A filtering window: rows whose paid / received time lies in [from, to). */
export interface RightsImportWindow {
  readonly time_basis: RightsImportTimeBasis;
  /** The instant as sent (ISO 8601 with offset), inclusive. */
  readonly from: string;
  /** The instant as sent (ISO 8601 with offset), exclusive. */
  readonly to: string;
}

export type CheckedRightsImportForm =
  | {
      readonly kind: 'rights' | 'punish';
      readonly platform: RightsImportPlatform;
      /** null: no window, no row is filtered (time_basis sent alone is dropped). */
      readonly window: RightsImportWindow | null;
    }
  | {
      readonly kind: 'channel';
      readonly platform: RightsImportPlatform;
      readonly union_account_id: string;
    };

export type RightsImportFormCheck =
  | { readonly ok: true; readonly form: CheckedRightsImportForm }
  | { readonly ok: false; readonly fields: readonly string[] };

/** One processed row as a processor reported it (application/rights-import-ports.ts). */
export type RightsImportRowOutcome =
  | { readonly kind: 'succeeded' }
  /** Outside the time window (skipped_rows); not a failure. */
  | { readonly kind: 'skipped' }
  /** Already imported under the BR-FUND-06 key (duplicate_rows); not a failure, nothing written. */
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'failed'; readonly reason: RightsImportFailureReason };

/** The five tallies of rights_imports (CT-24n field names). */
export interface RightsImportCounts {
  readonly total_rows: number;
  readonly succeeded_rows: number;
  readonly failed_rows: number;
  readonly skipped_rows: number;
  readonly duplicate_rows: number;
}

export function checkRightsImportForm(fields: RightsImportFormFields): RightsImportFormCheck {
  void fields;
  throw new Error('NotImplemented: checkRightsImportForm');
}

/** total_rows is the number of outcomes; every outcome counts in exactly one of the other four. */
export function countRightsImportRows(
  outcomes: readonly RightsImportRowOutcome[],
): RightsImportCounts {
  void outcomes;
  throw new Error('NotImplemented: countRightsImportRows');
}
