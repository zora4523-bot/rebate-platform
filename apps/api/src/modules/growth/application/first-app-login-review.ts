import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface LandingLoginReviewInput {
  readonly app_id: string;
  readonly user_id: string;
  readonly device_id_hash: string;
}

/** Structurally implements identity's FirstAppLoginReview; identity selects the first App login. */
export interface LandingLoginReview {
  review(trx: Transaction<DB>, input: LandingLoginReviewInput): Promise<void>;
}

/** The app assembler supplies identity's reader and risk's transactional hit writer. */
export interface FirstAppLoginReviewDeps {
  readonly clock: Clock;
  readonly loginDevices: {
    read(
      trx: Transaction<DB>,
      subject: { readonly app_id: string; readonly user_id: string },
    ): Promise<readonly string[]>;
  };
  readonly hitWriter: {
    record(
      trx: Transaction<DB>,
      input: {
        readonly app_id: string;
        readonly user_id: string;
        readonly rule_id: 'inv_09_same_device';
        readonly dimension: 'device_id_hash';
        readonly value_hmac: string;
      },
    ): Promise<void>;
  };
}

export function createFirstAppLoginReview(deps: FirstAppLoginReviewDeps): LandingLoginReview {
  void deps;
  throw new Error('NotImplemented: createFirstAppLoginReview');
}
