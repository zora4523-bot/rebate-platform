// B2-04zd: the production saveValidations of the bill job.
// D10-443 (a) 取 B: per-order validation results are not persisted; only the settle_bills totals and
// the recon diffs stay, and a batch launch re-runs the validation. This port writes nothing.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { BillSourceSelection, BillValidation } from '../job.ts';

export function saveBillValidations(
  trx: Transaction<DB>,
  input: BillSourceSelection,
  rows: readonly BillValidation[],
): Promise<void> {
  void trx;
  void input;
  void rows;
  throw new Error('NotImplemented: saveBillValidations');
}
