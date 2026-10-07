import type { ClientPlatform, Schema } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock, FieldCrypto, RootLogger } from '../../platform/index.ts';
import type { TokenService } from './access-tokens.ts';
import type { RegistrationService } from './registration.ts';
import type { MinimumVersionReader } from './session-scope.ts';
import type { SmsCodeService } from './sms-codes.ts';

/** Body is contract-validated; app/device/IP come from the verified request, never its body. */
export interface SmsLoginCommand {
  readonly body: Schema<'LoginBySmsRequest'>;
  readonly app_id: string;
  readonly device_id: string;
  readonly platform: ClientPlatform;
  readonly channel?: string;
  readonly version?: string;
  readonly client_ip: string;
}

export type SmsLoginResult =
  | { readonly code: 0; readonly data: Schema<'LoginData'> }
  | {
      readonly code: 20001;
      readonly data: { readonly fields: readonly ['phone']; readonly reason: 'phone_invalid' };
    }
  | { readonly code: 20002 | 20003 | 50001 }
  | { readonly code: 44001; readonly data?: { readonly risk_msg_code: string } }
  | {
      readonly code: 10405;
      readonly data: {
        readonly reason: 'no_account';
        readonly min_supported_version: string | null;
      };
    };

/** B1-11 supplies the review; identity selects landing-bound users with no login_logs.
 * Invoke on App platforms only, in the same transaction as the first successful login log.
 * This port cannot create a relationship. Absence means no work (no landing binds exist yet).
 */
export interface FirstAppLoginReview {
  review(
    trx: Transaction<DB>,
    input: {
      readonly app_id: string;
      readonly user_id: string;
      /** blindIndex(verifiedDevice.deviceId, 'login_logs.device_id').
       * Implementation exports LOGIN_LOGS_DEVICE_ID_CONTEXT from identity/index.ts.
       * Test-stage skeletons cannot declare initialized constants.
       */
      readonly device_id_hash: string;
    },
  ): Promise<void>;
}

export interface SmsLoginOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  readonly crypto: FieldCrypto;
  readonly logger: RootLogger;
  readonly versions: MinimumVersionReader;
  readonly sms: Pick<SmsCodeService, 'verifyAndConsume'>;
  readonly registration: RegistrationService;
  readonly tokens: TokenService;
  readonly firstAppLoginReview?: FirstAppLoginReview;
  /** B1-03d, only before creating an account; absent means no block. No plaintext phone. */
  readonly phoneBlocklist?: (
    trx: Transaction<DB>,
    input: { readonly app_id: string; readonly phone_hmac: string },
  ) => Promise<{ readonly code: 44001; readonly data?: { readonly risk_msg_code: string } } | null>;
}

export interface SmsLoginService {
  /** Scope → normalize → consume SMS → lookup → register/existing branch.
   * Own the PG transaction: registration, login consents/merge, growth review, log and session.
   * SMS consumption remains effective even when the PG transaction rejects or rolls back.
   * Pass login_method=sms when the session primitive supports the registered schema field.
   */
  login(command: SmsLoginCommand): Promise<SmsLoginResult>;
}

export function createSmsLoginService(options: SmsLoginOptions): SmsLoginService {
  void options;
  throw new Error('NotImplemented: createSmsLoginService');
}
