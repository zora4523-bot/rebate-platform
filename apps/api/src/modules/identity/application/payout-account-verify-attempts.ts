import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { BankCardVerifierPort } from '../ports/bank-card-verifier.ts';
import type { PayoutAccountConfigPort } from './payout-account.ts';

// B1-13f background seam for B1-13g: no account save or quota refund here.
// reserved -> unknown; unknown -> matched | mismatched | expired_unresolved.
// Every update must compare original status and row_version. released is not written.
export interface PayoutAccountVerifyAttemptsOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly verifier: BankCardVerifierPort | null;
  readonly config?: PayoutAccountConfigPort;
}

export interface PayoutVerifyAttemptSubject {
  readonly appId: string;
  readonly id: string;
}

export interface PayoutAccountVerifyAttempts {
  takeover(subject: PayoutVerifyAttemptSubject): Promise<void>;
  recheck(subject: PayoutVerifyAttemptSubject): Promise<void>;
}

export function createPayoutAccountVerifyAttempts(
  options: PayoutAccountVerifyAttemptsOptions,
): PayoutAccountVerifyAttempts {
  void options;
  throw new Error('NotImplemented: createPayoutAccountVerifyAttempts');
}
