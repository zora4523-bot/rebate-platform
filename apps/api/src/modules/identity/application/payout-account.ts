import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, FieldCrypto, RootLogger } from '../../platform/index.ts';
import type { BlocklistService } from '../../risk/index.ts';

export interface PayoutAccountSubject {
  readonly appId: string;
  readonly userId: string;
}

/** Trusted identity is supplied by the caller, never taken from the HTTP body. */
export interface SaveAlipayCommand extends PayoutAccountSubject {
  readonly alipayLogonId: string;
  readonly payeeName: string;
}

export type SaveAlipayResult =
  | { readonly code: 0; readonly data: components['schemas']['PayoutAccountAlipay'] }
  | {
      readonly code: 20001;
      readonly data: { readonly fields: readonly string[]; readonly reason?: 'phone_invalid' };
    }
  | { readonly code: 30304 | 30307 | 30308 }
  | { readonly code: 30303; readonly data: { readonly reason: 'payout_account_change_limit' } }
  | { readonly code: 44001; readonly data: { readonly risk_msg_code: string } };

export interface PayoutAccountServiceOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly logger: RootLogger;
  readonly blocklist: Pick<BlocklistService, 'check'>;
}

export interface PayoutAccountService {
  /**
   * B1-13e: use this exact caller transaction; users FOR UPDATE before mutable reads.
   * Refusals leave payout rows unchanged. No step-up or idempotency settlement here:
   * B1-13f calls save inside its existing idempotency / withStepUp transaction.
   * Cipher AAD is payout_accounts.alipay (bank read: payout_accounts.bank_card),
   * also the blind-index domain shared with risk. Never return plaintext or HMAC.
   */
  save(trx: Transaction<DB>, command: SaveAlipayCommand): Promise<SaveAlipayResult>;
}

export function createPayoutAccountService(
  options: PayoutAccountServiceOptions,
): PayoutAccountService {
  void options;
  throw new Error('NotImplemented: createPayoutAccountService');
}
