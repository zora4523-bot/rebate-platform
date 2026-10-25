// B1-09k: the kind=rights / punish row processors of the rights_import job (08 BR-FUND-06 细则
// 「维权导入任务」; orchestrator ruling D10-152; plan orders-plan-b109-v2 §B1-09k, C-9, J-13, J-22,
// K-3). Rule tests: test/spec/orders/rights-import-rows/**. One row is at most one order_rights
// record, written only through settlement's rights.record (recordOrderRights, B1-09c): orders never
// writes order_rights itself (02 §4.1).
//   - row.values (template column names; the real templates wait for the owner's samples, K-3):
//     `sub_order_id` (text, trimmed), `parent_order_id` (optional column), `platform` (optional
//     column: the platform code of the row), `rights_no` (the platform's rights / violation number;
//     empty → null), `status` (rights only: PROCESSING / SUCCEEDED / FAILED), `amount` and
//     `deduction_commission` (yuan with at most two decimals, a text or a number cell; empty →
//     null), `occurred_at` (required: an ISO 8601 text — with Z or an offset as given, without one
//     or date only read at +08:00 — or a Date cell of the sheet);
//   - judged in this order, a failed row writes nothing: a required cell missing or unreadable →
//     invalid_row; the row's platform ≠ the task's → platform_mismatch; only a parent order number
//     (no sub-order number, or the number is a parent order's: never expanded to its children) →
//     sub_order_no_missing; no sub-order of the task's app and platform → order_not_found; with a
//     window (task from / to) the sub-order's paid_at (time_basis paid) or received_at (time_basis
//     received) must lie in [from, to): outside → skipped (nothing written), received basis and no
//     received_at → received_at_missing. No window: no row is filtered;
//   - rights → type RIGHTS, the row's status; punish → type PUNISH, status SUCCEEDED; source IMPORT,
//     now = the injected Clock; `before` is the order row re-read FOR UPDATE after lockOrderKey of
//     the sub-order (one transaction per row, the lock first);
//   - amounts only through @couli/money's decimal string conversion (a number cell is read as its
//     decimal text), never Number × 100: '0.29' → 29n, '1.15' → 115n;
//   - port answers: applied → succeeded; duplicate (BR-FUND-06 key already imported) → duplicate,
//     not a failure, nothing written again; not_applicable (settlement wrote nothing) → skipped,
//     not a failure and not retried; a thrown error propagates (the job retries the row);
//   - with the job's transaction (rights-import-ports.ts) every statement runs on it and nothing is
//     committed here, so a redelivered row counts once; without one each row is its own transaction;
//   - rights.record not injected: no processor is returned for rights / punish, so the job ends the
//     task failed and logs it at error (J-22); no order_rights is written.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { RightsImportProcessors } from './rights-import-ports.ts';
import type { OrderRightsPorts } from './rights-ports.ts';

export interface RightsImportRowDeps {
  /** Opens the row's transaction when the job hands none. */
  readonly db: Kysely<DB>;
  /** RightsRecordInput.now. */
  readonly clock: Clock;
  /** settlement's rights.record (B1-09c); absent → no rights / punish processor (J-22). */
  readonly ports: OrderRightsPorts | undefined;
}

/** The rights and punish processors (both, or neither when rights.record is not injected). */
export function createRightsImportProcessors(deps: RightsImportRowDeps): RightsImportProcessors {
  void deps;
  throw new Error('NotImplemented: createRightsImportProcessors');
}
