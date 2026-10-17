import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export type LedgerAccountRef =
  | { readonly ownerType: 'user'; readonly accountId: string }
  | { readonly ownerType: 'platform'; readonly subject: string };

export interface PostingEntry {
  readonly account: LedgerAccountRef;
  /** Storage sub-account. Platform entries use available; domain projection uses null. */
  readonly sub_account: 'available' | 'frozen';
  readonly amount_fen: bigint;
  readonly ledger_type: string;
  readonly sub_type: string | null;
  readonly income_type: 'SERVICE_FEE' | 'INCIDENTAL' | null;
}

export interface PostingVoucher {
  readonly appId: string;
  readonly uniqKey: string;
  readonly bizType: string;
  readonly bizId: string;
  readonly operator: string;
  readonly memo: string | null;
  readonly orderKey: string | null;
  readonly beneficiaryUserId: string | null;
  readonly role: 'self' | 'share' | 'direct' | 'indirect' | null;
  /** Trusted caller context, including R14 REASSIGN_REV; never inferred from uniqKey. */
  readonly voucherKind: string | null;
  readonly entries: readonly PostingEntry[];
}

export interface BalanceSelection {
  readonly appId: string;
  readonly userIds: readonly string[];
}

export interface AccountBalance {
  readonly app_id: string;
  readonly account_id: string;
  readonly user_id: string;
  readonly available_fen: bigint;
  readonly frozen_fen: bigint;
  readonly version: bigint;
  /** +08:00 accounting date, YYYY-MM-DD, or null. */
  readonly negative_since: string | null;
}

export interface PostingResult {
  readonly kind: 'posted' | 'duplicate';
  readonly voucherId: string;
}

export interface Ledger {
  openUserAccount(
    trx: Transaction<DB>,
    input: { readonly appId: string; readonly userId: string },
  ): Promise<AccountBalance>;
  /** Caller locks users first. This method locks only balance rows, in account_id order. */
  lockBalances(trx: Transaction<DB>, input: BalanceSelection): Promise<readonly AccountBalance[]>;
  /** Requires this transaction's balance locks; never opens or commits another transaction. */
  post(trx: Transaction<DB>, voucher: PostingVoucher): Promise<PostingResult>;
  getBalances(db: Kysely<DB>, input: BalanceSelection): Promise<readonly AccountBalance[]>;
}

export function createLedger(input: { readonly clock: Clock }): Ledger {
  void input;
  throw new Error('NotImplemented: createLedger');
}
