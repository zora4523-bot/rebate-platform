// B2-04y: GET /v1/wallet/summary's one query (BR-FUND-18; BR-FUND-10 / 13). The single balance is
// ledger's own account_balances row, read live; the estimate fields come through the
// PendingEarningsSource port ledger declares and settlement implements (S3), withdrawn total, risk
// pause reason and withdraw.enabled through their owners' ports. Everything is read on one
// read-only REPEATABLE READ transaction, nothing is written and nothing is cached (BR-FUND-18
// allows at most 60 seconds for the estimates; no cache is within that bound). A port failure
// propagates: the summary never answers zero earnings or a safe state it did not read.
import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { addFen, fenToJsonNumber, subFen } from '@couli/money';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { readBalancesByUser } from '../infra/store.ts';
import type { PendingEarningsSource } from './asset-snapshot.ts';

export interface WalletSubject {
  readonly appId: string;
  readonly userId: string;
}

/** Foreign data comes through owner-module ports, never through ledger table access. */
export interface WalletSummaryDependencies {
  readonly clock: Clock;
  readonly pendingEarnings: PendingEarningsSource;
  readonly withdrawals: {
    /** Sum amount_fen of PAID_API / PAID_MANUAL only, for this app and user. */
    readPaidTotal(db: Kysely<DB>, subject: WalletSubject): Promise<bigint>;
  };
  readonly risk: {
    /** Public reason key for frozen risk state / effective withdrawal hold; otherwise null. */
    readPauseReason(db: Kysely<DB>, subject: WalletSubject): Promise<string | null>;
  };
  readonly config: {
    readWithdrawEnabled(appId: string): Promise<boolean>;
  };
}

export type WalletSummaryQuery = (subject: WalletSubject) => Promise<Schema<'WalletSummary'>>;

/** Runs on the caller's transaction, or on its own read-only REPEATABLE READ one. */
async function readOnly<T>(db: Kysely<DB>, run: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  if (db.isTransaction) return run(db);
  return db
    .transaction()
    .setIsolationLevel('repeatable read')
    .setAccessMode('read only')
    .execute((trx: Transaction<DB>) => run(trx));
}

export async function getWalletSummary(
  db: Kysely<DB>,
  subject: WalletSubject,
  dependencies: WalletSummaryDependencies,
): Promise<Schema<'WalletSummary'>> {
  const who: WalletSubject = { appId: subject.appId, userId: subject.userId };
  const read = await readOnly(db, async (trx) => {
    const rows = await readBalancesByUser(trx, who.appId, [who.userId]);
    const own = rows.find((row) => row.app_id === who.appId && row.user_id === who.userId);
    const pending = await dependencies.pendingEarnings.readUser(trx, who);
    const withdrawn = await dependencies.withdrawals.readPaidTotal(trx, who);
    const pauseReason = await dependencies.risk.readPauseReason(trx, who);
    return { own, pending, withdrawn, pauseReason };
  });
  const withdrawEnabled = await dependencies.config.readWithdrawEnabled(who.appId);

  // A user without an account row yet has the zero balance every account starts with
  // (BR-FUND-13); no account is created by a read.
  const available = read.own?.available_fen ?? 0n;
  const frozen = read.own?.frozen_fen ?? 0n;
  const { pending } = read;
  return {
    available_fen: fenToJsonNumber(available),
    withdrawable_fen: fenToJsonNumber(available > 0n ? available : 0n),
    negative_fen: fenToJsonNumber(available < 0n ? subFen(0n, available) : 0n),
    frozen_fen: fenToJsonNumber(frozen),
    estimated_total_fen: fenToJsonNumber(addFen(pending.estimated_fen, pending.pending_credit_fen)),
    estimated_fen: fenToJsonNumber(pending.estimated_fen),
    pending_credit_fen: fenToJsonNumber(pending.pending_credit_fen),
    pending_credit_paused_fen: fenToJsonNumber(pending.pending_credit_paused_fen),
    next_credit_period: pending.next_credit_period,
    credit_overdue: pending.credit_overdue,
    withdrawn_fen: fenToJsonNumber(read.withdrawn),
    risk_paused_reason: read.pauseReason,
    withdraw_enabled: withdrawEnabled,
  };
}
