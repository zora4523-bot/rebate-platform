// B2-16b: ledger's writer of the invite reward vouchers, the implementation of growth's
// InviteRewardGrantWriter (08 BR-INV-24 ② ⑦, BR-FUND-15, BR-FUND-16; specs/ledger-templates.csv
// REWARD:INVITE: debit platform MKT_EXPENSE, credit the user's USER_BALANCE available, reward_fen).
//
// One voucher per paid party in the caller's transaction, uniq_key
// INVITE_REWARD:{invitee_user_id}:{side}, through the given ledger only (openUserAccount when the
// account is missing, lockBalances, post); a replayed key returns the stored voucher without a new
// entry; an amount of 0 writes nothing. Input checks run before any SQL (LedgerError INVALID_INPUT):
// amount a bigint >= 0, party inviter | invitee, the invitee side paid to the invitee and the
// inviter side to someone else, nonempty ids, a valid `at`.
//
// Also compiled by the `test` project (through ../index.ts): erasable syntax only, `import type`
// for type-only imports, relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Ledger } from './reverse.ts';

/** The beneficiary side of an invite reward (the {side} of the uniq_key). */
export type InviteRewardSide = 'inviter' | 'invitee';

/** Same fields as growth's InviteRewardGrantInput. */
export interface InviteRewardGrantRequest {
  readonly app_id: string;
  /** The invitee: the idempotency subject of both vouchers. */
  readonly invitee_id: string;
  readonly party: InviteRewardSide;
  /** The beneficiary credited on this side. */
  readonly user_id: string;
  /** reward_fen, the per-party amount locked on the qualification record. */
  readonly amount_fen: bigint;
  readonly at: Date;
}

/**
 * posted: a new voucher; duplicate: the key was already booked, its voucher is returned and nothing
 * is written; zero: amount 0, no voucher (the key stays free).
 */
export type InviteRewardGrantOutcome =
  | { readonly kind: 'posted' | 'duplicate'; readonly voucher_id: string }
  | { readonly kind: 'zero'; readonly voucher_id: null };

export interface InviteRewardVoucherWriter {
  grant(trx: Transaction<DB>, input: InviteRewardGrantRequest): Promise<InviteRewardGrantOutcome>;
}

export interface InviteRewardGrantWriterDeps {
  /** The ledger every voucher and balance change goes through (its Clock, events and hooks). */
  readonly ledger: Ledger;
}

export function createInviteRewardGrantWriter(
  deps: InviteRewardGrantWriterDeps,
): InviteRewardVoucherWriter {
  void deps;
  throw new Error('NotImplemented: createInviteRewardGrantWriter');
}
