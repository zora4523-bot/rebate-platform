import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Ledger } from '../../ledger/index.ts';
import type { EventBus } from '../../platform/index.ts';
import type { WithdrawBlock } from '../domain/withdraw-rules.ts';
import type { WithdrawActor, WithdrawRulesOptions } from './withdraw-rules.ts';

/** Identity supplies the current, encrypted payee snapshot on the caller's handle. */
export interface WithdrawPayeeSnapshot {
  payout_method: 'alipay' | 'bank_card';
  payee_name: string;
  payee_account_cipher: Buffer;
  payee_hmac: string;
  bank_name: string | null;
  /** Transient cleartext for masking; never returned, logged or put in an event. */
  account: string;
}

export interface WithdrawApplyOptions {
  /** Reuse B2-05c's validator and readers for the first pass and locked subset ⑦⑧⑩⑪⑫. */
  rules: WithdrawRulesOptions;
  ledger: Ledger;
  lockUsersForUpdate(
    trx: Transaction<DB>,
    input: { appId: string; userIds: readonly string[] },
  ): Promise<ReadonlySet<string>>;
  snapshot: {
    read(handle: Kysely<DB>, actor: WithdrawActor): Promise<WithdrawPayeeSnapshot | null>;
  };
  /** New candidate for each insert attempt; at most three retries after a collision. */
  outBizNo(): string;
  eventBus?: EventBus;
}

export interface WithdrawApplyCommand extends WithdrawActor {
  amountFen: bigint;
  stepUpValid: boolean;
}

export type WithdrawApplyResult = { code: 0; data: Schema<'Withdrawal'> } | WithdrawBlock;

export interface WithdrawApplyService {
  /** Caller owns the transaction (production: idempotency.executeInTransaction). */
  apply(trx: Transaction<DB>, command: WithdrawApplyCommand): Promise<WithdrawApplyResult>;
}

export function createWithdrawApply(options: WithdrawApplyOptions): WithdrawApplyService {
  void options;
  throw new Error('NotImplemented: createWithdrawApply');
}
