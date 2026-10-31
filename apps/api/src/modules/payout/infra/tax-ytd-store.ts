// B2-08b (BR-WDR-20; 04 §3.2 tax_ytd; B2-08a's table): payout's only write of app.tax_ytd — the
// upsert of one paid withdrawal into the (app, user, year, income_type, identity) row, on the
// caller's transaction. INSERT … ON CONFLICT ON CONSTRAINT tax_ytd_identity_key DO UPDATE adds the
// amounts to the existing row and moves updated_at; the row's id and created_at never change.
// couli_app holds INSERT and UPDATE (cum_income_fen, cum_withheld_fen, continuous_months,
// updated_at) on the table (0103_tax-ytd.sql); continuous_months is B2-08c's.
import type { DB } from '@couli/db';
import { sql, type Transaction } from 'kysely';

export interface TaxYtdUpsert {
  /** The id of the row if it is new (application UUIDv7). */
  readonly id: string;
  readonly appId: string;
  readonly userId: string;
  readonly year: number;
  readonly incomeType: string;
  readonly identityHmac: string;
  /** Added to cum_income_fen (≥ 0, checked by the caller). */
  readonly incomeFen: bigint;
  /** Added to cum_withheld_fen (≥ 0, checked by the caller). */
  readonly withheldFen: bigint;
  /** updated_at, and created_at of a new row (the caller's Clock time). */
  readonly now: Date;
}

export async function upsertTaxYtd(trx: Transaction<DB>, input: TaxYtdUpsert): Promise<void> {
  await trx
    .withSchema('app')
    .insertInto('tax_ytd')
    .values({
      id: input.id,
      app_id: input.appId,
      user_id: input.userId,
      year: input.year,
      income_type: input.incomeType,
      identity_hmac: input.identityHmac,
      cum_income_fen: input.incomeFen,
      cum_withheld_fen: input.withheldFen,
      created_at: input.now,
      updated_at: input.now,
    })
    .onConflict((oc) =>
      oc.constraint('tax_ytd_identity_key').doUpdateSet({
        cum_income_fen: sql<bigint>`tax_ytd.cum_income_fen + excluded.cum_income_fen`,
        cum_withheld_fen: sql<bigint>`tax_ytd.cum_withheld_fen + excluded.cum_withheld_fen`,
        updated_at: input.now,
      }),
    )
    .execute();
}
