// B2-08b (规划/08 BR-WDR-20 税额计算与年度台账; 04 §3.2 tax_ytd; 编排裁定 D10-181 ①, D10-456 ④,
// D10-459): the year's running totals of a member's paid withdrawals, kept per real-name identity.
// Only a withdrawal reaching PAID_API / PAID_MANUAL is added (W5 payout-landing, W11
// withdrawal-proven-success; W8 / W10 with their own tasks); a rejection or a failure adds nothing.
// accumulate(trx, input) runs on the caller's transaction, once, right after its CAS moved the
// withdrawal (a redelivery moves no row and never gets here):
//   year          the +08:00 calendar year of the withdrawal's created_at (taxYearOf, through
//                 @couli/domain's accountingDate; never getFullYear);
//   income_type   'SERVICE_FEE' (BR-FUND-13: every withdrawal is one income type);
//   identity_hmac identity's port: the id_no_hmac of the member's verified real name, read on the
//                 same transaction. None (not verified) → logger.warn 'tax_ytd_identity_missing'
//                 (ids and year only) and throw: the caller's transaction rolls back (a paid
//                 withdrawal always has a real name, BR-WDR-03; never swallowed);
//   upsert        INSERT … ON CONFLICT ON CONSTRAINT tax_ytd_identity_key DO UPDATE SET
//                 cum_income_fen += amount_fen, cum_withheld_fen += tax_fen, updated_at = now (the
//                 caller's Clock time; infra/tax-ytd-store.ts); a new row gets an application
//                 UUIDv7 id. Amounts go through @couli/money (bigint, ≥ 0) before anything is read
//                 or written.
// A real name corrected by customer service has another hmac: its withdrawals start a row of their
// own and the former identity's row is never added to again (no user.realname_corrected consumer,
// 规划/02 §11). Logs never carry the hmac, the name or the id number.
import type { DB } from '@couli/db';
import { accountingDate } from '@couli/domain';
import { parseFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import { newUuidV7 } from '../../platform/index.ts';
import { upsertTaxYtd } from '../infra/tax-ytd-store.ts';

/** The income type of every withdrawal (BR-WDR-20, BR-FUND-13). */
export type TaxYtdIncomeType = 'SERVICE_FEE';

/** The warn line of a paid withdrawal whose member has no verified real name. */
export const TAX_YTD_IDENTITY_MISSING = 'tax_ytd_identity_missing';
export type TaxYtdIdentityMissingAlert = typeof TAX_YTD_IDENTITY_MISSING;

/**
 * identity's realname-identity-key port as payout uses it (app.module hands in identity's
 * createRealnameIdentityKeyReader(); payout imports nothing from identity).
 */
export interface TaxYtdIdentityKeyReader {
  readIdentityKey(
    executor: Transaction<DB> | Kysely<DB>,
    input: { readonly appId: string; readonly userId: string },
  ): Promise<string | null>;
}

export interface TaxYtdLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface TaxYtdAccumulatorOptions {
  readonly identity: TaxYtdIdentityKeyReader;
  readonly logger: TaxYtdLogger;
}

export interface TaxYtdAccumulateInput {
  readonly appId: string;
  readonly userId: string;
  /** The withdrawal that has just reached PAID_API / PAID_MANUAL (logs only). */
  readonly withdrawalId: string;
  /** The withdrawal's created_at: its +08:00 calendar year is the tax year. */
  readonly createdAt: Date;
  /** The withdrawal's amount_fen, added to cum_income_fen. */
  readonly amountFen: bigint;
  /** The withdrawal's tax_fen (fixed at application), added to cum_withheld_fen. */
  readonly taxFen: bigint;
  /** The caller's Clock time: updated_at (and created_at of a new row). */
  readonly now: Date;
}

export interface TaxYtdAccumulator {
  accumulate(trx: Transaction<DB>, input: TaxYtdAccumulateInput): Promise<void>;
}

/** A paid withdrawal whose member has no verified real name (the caller's transaction rolls back). */
export class TaxYtdIdentityMissingError extends Error {
  override readonly name = 'TaxYtdIdentityMissingError';
  readonly withdrawalId: string;
  constructor(withdrawalId: string) {
    super(`tax_ytd: no verified real name for the paid withdrawal ${withdrawalId}`);
    this.withdrawalId = withdrawalId;
  }
}

/** An amount that is not a non-negative fen amount (refused before anything is read or written). */
export class TaxYtdAmountError extends Error {
  override readonly name = 'TaxYtdAmountError';
  constructor(field: 'amount_fen' | 'tax_fen') {
    super(`tax_ytd: ${field} must be a non-negative fen amount`);
  }
}

const INCOME_TYPE: TaxYtdIncomeType = 'SERVICE_FEE';

/** The tax year of a withdrawal: the +08:00 calendar year of its created_at (BR-WDR-20). */
export function taxYearOf(createdAt: Date): number {
  return Number(accountingDate(createdAt).slice(0, 4));
}

function nonNegativeFen(value: bigint, field: 'amount_fen' | 'tax_fen'): bigint {
  let fen: bigint;
  try {
    fen = parseFen(value);
  } catch {
    throw new TaxYtdAmountError(field);
  }
  if (fen < 0n) throw new TaxYtdAmountError(field);
  return fen;
}

export function createTaxYtdAccumulator(options: TaxYtdAccumulatorOptions): TaxYtdAccumulator {
  const { identity, logger } = options;
  return {
    async accumulate(trx, input) {
      const amountFen = nonNegativeFen(input.amountFen, 'amount_fen');
      const taxFen = nonNegativeFen(input.taxFen, 'tax_fen');
      const year = taxYearOf(input.createdAt);
      const identityHmac = await identity.readIdentityKey(trx, {
        appId: input.appId,
        userId: input.userId,
      });
      if (identityHmac === null) {
        logger.warn(
          {
            app_id: input.appId,
            withdrawal_id: input.withdrawalId,
            user_id: input.userId,
            year,
          },
          TAX_YTD_IDENTITY_MISSING,
        );
        throw new TaxYtdIdentityMissingError(input.withdrawalId);
      }
      await upsertTaxYtd(trx, {
        id: newUuidV7(input.now),
        appId: input.appId,
        userId: input.userId,
        year,
        incomeType: INCOME_TYPE,
        identityHmac,
        incomeFen: amountFen,
        withheldFen: taxFen,
        now: input.now,
      });
    },
  };
}
