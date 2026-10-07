import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, FieldCrypto, RootLogger } from '../../platform/index.ts';

export type BlocklistDimension =
  'phone' | 'id_no' | 'alipay' | 'bank_card' | 'wechat_openid' | 'device' | 'relation_id';

/** Shared by risk, backend registration (F1-10) and payout accounts (B2).
 * A function exposes the shared contexts because test-stage skeletons cannot initialize constants.
 * Device hashes are already digests and have no blindIndex context.
 */
export function blocklistHmacContexts(): Readonly<
  Record<Exclude<BlocklistDimension, 'device'>, string>
> {
  throw new Error('NotImplemented: blocklistHmacContexts');
}

export interface BlockedRequest {
  readonly app_id: string;
  readonly request_type: 'register' | 'withdraw' | 'phone_change' | 'payout_account' | null;
  readonly related_phone: string;
  readonly user_id?: string;
  readonly amount_fen?: bigint;
  /** Reuse the first hit's UUIDv7 for other dimensions of the same request. */
  readonly ref_id?: string;
}

export type BlocklistInput = BlockedRequest & {
  readonly dimension: BlocklistDimension;
} & (
    | { readonly value: string; readonly value_hmac?: never }
    | { readonly value_hmac: string; readonly value?: never }
  );

export interface BlocklistHit {
  readonly code: 44001;
  readonly data: { readonly risk_msg_code: string };
  readonly ref_id: string;
}

export interface RecordBlockedHit extends BlockedRequest {
  readonly dimension: string;
  readonly value_hmac: string;
  readonly rule_id: string;
}

export interface BlockedRegistrationInput {
  readonly app_id: string;
  readonly device_hash: string;
  readonly count: number;
  readonly limit: number;
  readonly phone_hmac: string | null;
  readonly third_party_digest: string | null;
}

export interface RegistrationBlocklistInput {
  readonly app_id: string;
  readonly phone_hmac: string;
  readonly device_hash?: string;
  readonly related_phone: string;
}

export interface BlocklistService {
  /** Check account dimensions without consulting users; persist hits in an independent transaction. */
  check(input: BlocklistInput): Promise<BlocklistHit | null>;
  /** Check both phone and optional device before registration; all hits share one ref_id.
   * Audit writes use an independent transaction even when the caller rolls back trx.
   */
  checkRegistration(
    trx: Transaction<DB>,
    input: RegistrationBlocklistInput,
  ): Promise<BlocklistHit | null>;
  /** For prefix/device-limit decisions already made by identity. */
  recordHit(input: RecordBlockedHit): Promise<{ readonly ref_id: string }>;
  /** No backend-issued release record means false; this port does not create release records. */
  allowBlockedRegistration(trx: Transaction<DB>, input: BlockedRegistrationInput): Promise<boolean>;
}

export interface BlocklistOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly logger: RootLogger;
}

export function createBlocklistService(options: BlocklistOptions): BlocklistService {
  void options;
  throw new Error('NotImplemented: createBlocklistService');
}
