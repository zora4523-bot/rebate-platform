import type { Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, FieldCrypto, TokenPrincipal } from '../../platform/index.ts';
import type { TokenKeyProvider } from './access-tokens.ts';
import type { OauthAttemptService } from './oauth-attempts.ts';
import type { SmsCodeService, SmsConfigReader } from './sms-codes.ts';

export type ThirdPartyCredentials =
  | { readonly provider: 'wechat'; readonly code: string }
  | {
      readonly provider: 'apple';
      readonly identity_token: string;
      readonly authorization_code: string;
    }
  | { readonly provider: 'huawei'; readonly authorization_code: string };

/** CT-15i performs the exchange and verification; absence must fail closed with 50305. */
export interface ThirdPartyIdentityPort {
  exchange(
    input: ThirdPartyCredentials & { readonly nonce: string },
  ): Promise<
    { readonly union_id: string } | { readonly unavailable: true } | { readonly invalid: true }
  >;
}

export interface StepUpCommand {
  readonly body: Schema<'StepUpRequest'>;
  readonly principal: TokenPrincipal;
  readonly verifiedDevice: { readonly appId: string; readonly deviceId: string };
}

export type StepUpResult =
  | { readonly code: 0; readonly data: Schema<'StepUpData'> }
  | { readonly code: 20002 | 20003 | 50001 }
  | { readonly code: 20001; readonly data: { readonly fields: readonly string[] } }
  | { readonly code: 20004; readonly data?: { readonly reason: 'identity_mismatch' } }
  | { readonly code: 50305; readonly data: { readonly provider: Schema<'LoginProvider'> } };

export interface StepUpService {
  verify(command: StepUpCommand): Promise<StepUpResult>;
}

export interface StepUpOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly keys: TokenKeyProvider;
  readonly config: SmsConfigReader;
  readonly sms: SmsCodeService;
  readonly attempts: OauthAttemptService;
  readonly thirdPartyIdentity?: ThirdPartyIdentityPort;
}

export function createStepUpService(options: StepUpOptions): StepUpService {
  void options;
  throw new Error('NotImplemented: createStepUpService');
}
