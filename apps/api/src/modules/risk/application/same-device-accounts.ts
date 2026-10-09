import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RootLogger } from '../../platform/index.ts';
import type { RateLimitConfigReader } from './rate-limit.ts';

/** identity returns first successful logins per account/device in the closed window.
 * Include merged tombstones and their target IDs from user_oauth; risk owns dedupe/ranking.
 * Return all accounts on devices the subject logged into in this window; omit null hashes.
 */
export interface SameDeviceFirstLogin {
  readonly device_hash: string;
  readonly user_id: string;
  readonly first_login_at: Date;
  readonly login_log_id: bigint;
  readonly status: string;
  readonly deleted_reason: string | null;
  readonly merged_into_user_id: string | null;
}

export interface SameDeviceLoginReader {
  read(
    handle: Kysely<DB>,
    input: {
      readonly app_id: string;
      readonly user_id: string;
      readonly window_start: Date;
      readonly window_end: Date;
    },
  ): Promise<readonly SameDeviceFirstLogin[]>;
}

export interface SameDeviceAccountsInput {
  readonly app_id: string;
  readonly user_id: string;
  readonly ref: { readonly type: 'withdrawal'; readonly id: string };
}

export interface SameDeviceAccountsResult {
  readonly marked: boolean;
  readonly devices: readonly { readonly device_hash: string; readonly rank: number }[];
}

export interface SameDeviceAccountsCheck {
  judge(handle: Kysely<DB>, input: SameDeviceAccountsInput): Promise<SameDeviceAccountsResult>;
}

export interface SameDeviceAccountsOptions {
  readonly clock: Clock;
  readonly logger: RootLogger;
  readonly logins: SameDeviceLoginReader;
  /** Bind the existing configuration port to the caller's handle; no pooled reads. */
  readonly config: (handle: Kysely<DB>) => RateLimitConfigReader;
}

export function createSameDeviceAccountsCheck(
  options: SameDeviceAccountsOptions,
): SameDeviceAccountsCheck {
  void options;
  throw new Error('NotImplemented: createSameDeviceAccountsCheck');
}

export function sameDeviceAccountsCheckToken(): symbol {
  throw new Error('NotImplemented: sameDeviceAccountsCheckToken');
}

export function sameDeviceLoginReaderToken(): symbol {
  throw new Error('NotImplemented: sameDeviceLoginReaderToken');
}
