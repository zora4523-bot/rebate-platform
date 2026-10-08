import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, RedisHandle, TokenPrincipal } from '../../platform/index.ts';
import type { SmsConfigReader } from './sms-codes.ts';

export interface OauthAttemptBinding {
  readonly app_id: string;
  readonly provider: Schema<'LoginProvider'>;
  readonly purpose: Schema<'OauthAttemptPurpose'>;
  readonly device_id: string;
  readonly uid?: string;
  readonly action?: Schema<'StepUpAction'>;
}

export interface OauthAttemptCommand {
  readonly body: Schema<'CreateOauthAttemptRequest'>;
  readonly verifiedDevice: { readonly appId: string; readonly deviceId: string };
  readonly principal?: TokenPrincipal;
}

export type OauthAttemptResult =
  | { readonly code: 0; readonly data: Schema<'OauthAttemptData'> }
  | { readonly code: 10001 | 20004 | 50001 }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } };

export interface OauthAttemptService {
  issue(command: OauthAttemptCommand): Promise<OauthAttemptResult>;
  /** Compare every binding before atomic consumption; failure must leave the attempt intact. */
  consume(
    binding: OauthAttemptBinding & { readonly attempt_id: string },
  ): Promise<
    | { readonly code: 0; readonly data: { readonly nonce: string } }
    | { readonly code: 20004 | 50001 }
  >;
}

export interface OauthAttemptOptions {
  readonly db: Kysely<DB>;
  readonly redis: RedisHandle;
  readonly clock: Clock;
  readonly config: SmsConfigReader;
}

export function createOauthAttemptService(options: OauthAttemptOptions): OauthAttemptService {
  void options;
  throw new Error('NotImplemented: createOauthAttemptService');
}
