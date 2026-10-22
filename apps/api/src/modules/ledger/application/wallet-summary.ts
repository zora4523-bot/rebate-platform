import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
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

export async function getWalletSummary(
  db: Kysely<DB>,
  subject: WalletSubject,
  dependencies: WalletSummaryDependencies,
): Promise<Schema<'WalletSummary'>> {
  void db;
  void subject;
  void dependencies;
  throw new Error('NotImplemented: getWalletSummary');
}
