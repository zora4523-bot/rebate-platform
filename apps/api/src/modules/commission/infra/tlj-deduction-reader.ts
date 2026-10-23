// B2-04y: commission's read-only port for a sub-order's immutable commission_splits.tlj_deduct_fen
// (BR-CALC-02), always inside the caller's transaction so it reads the same snapshot as the
// caller's other reads. SELECT only — no locking clause (works in READ ONLY transactions and for
// couli_readonly), no SQL clock; filtered by both app_id and order_id.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface TljDeductionInput {
  readonly appId: string;
  readonly orderId: string;
}

/** The sub-order has no commission_splits row: never answered with a default 0 (BR-CALC-02). */
export class TljDeductionMissing extends Error {
  readonly appId: string;
  readonly orderId: string;

  constructor(input: TljDeductionInput) {
    super(`commission split missing for order ${input.orderId}`);
    this.name = 'TljDeductionMissing';
    this.appId = input.appId;
    this.orderId = input.orderId;
  }
}

/** commission_splits.tlj_deduct_fen of the sub-order, in integer fen. */
export async function readTljDeductFen(
  trx: Transaction<DB>,
  input: TljDeductionInput,
): Promise<bigint> {
  const row = await trx
    .withSchema('app')
    .selectFrom('commission_splits')
    .select('tlj_deduct_fen')
    .where('app_id', '=', input.appId)
    .where('order_id', '=', input.orderId)
    .executeTakeFirst();
  if (row === undefined) throw new TljDeductionMissing(input);
  return row.tlj_deduct_fen;
}
