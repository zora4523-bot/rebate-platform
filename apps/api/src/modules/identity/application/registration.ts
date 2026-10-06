// B1-02i registration.ts: decorator-free service surface, shared by SMS/OAuth/landing callers.
// Test phase only: every executable declaration is a NotImplemented skeleton.
import type { DB } from '@couli/db';
import type { components, UserLevel } from '@couli/contracts-ts';
import type { Transaction } from 'kysely';
import type { Clock, FieldCrypto, RootLogger } from '../../platform/index.ts';
import type { SmsConfigReader } from './sms-codes.ts';

export type RegisterMethod = 'sms' | 'wechat' | 'apple' | 'huawei' | 'h5_landing' | 'admin';
export type InviteBindResult = components['schemas']['InviteBind'];
export interface RegistrationCommand {
  readonly app_id: string;
  readonly phone: string | null;
  // B1-02d supplies the third-party identity digest; SMS callers omit it or pass null.
  readonly third_party_digest?: string | null;
  readonly register_method: RegisterMethod;
  readonly channel?: string;
  readonly device_hash?: string;
  readonly device_id?: string;
  readonly invite_code?: string;
  readonly client_ip: string;
}
export interface DeviceLimitContext {
  readonly app_id: string;
  readonly device_hash: string;
  readonly count: number;
  readonly limit: number;
}
export type RegistrationResult =
  | {
      readonly code: 0;
      readonly user_id: string;
      readonly invite_code: string;
      readonly attr_code: string;
      readonly invite_bind?: InviteBindResult;
    }
  | ({ readonly code: 44001; readonly kind: 'device_register_limit' } & DeviceLimitContext)
  | { readonly code: 50001 }
  | { readonly outcome: 'phone_taken' };
export interface RegistrationService {
  // Non-success rolls back this service's writes, preserving the caller's earlier writes.
  register(trx: Transaction<DB>, command: RegistrationCommand): Promise<RegistrationResult>;
}
export interface SensitiveWords {
  matches(scene: 'invite_code', candidate: string): boolean;
}
export interface RegistrationOptions {
  readonly clock: Clock;
  readonly config: SmsConfigReader;
  readonly crypto: FieldCrypto;
  readonly logger: RootLogger;
  readonly sensitiveWords: SensitiveWords;
  // Default sources must use CSPRNG; invite: at most 5 draws; attr exhaustion: 50001 + warn.
  // Implementation default for attr retries: 5 candidates including the first; tests leave it open.
  readonly inviteCandidate?: () => string;
  readonly attrCandidate?: () => string;
  readonly bindInvite?: (
    trx: Transaction<DB>,
    input: RegistrationCommand & {
      readonly user_id: string;
      readonly invite_code: string;
    },
  ) => Promise<InviteBindResult>;
  // B1-03g: once on success, in the caller's transaction before commit.
  readonly afterRegistered?: (
    trx: Transaction<DB>,
    input: RegistrationCommand & {
      readonly user_id: string;
    },
  ) => Promise<void>;
  // B1-03d: default denies; ordered before returning the device-limit rejection.
  readonly allowBlockedRegistration?: (
    trx: Transaction<DB>,
    // BR-ID-36 closure: bind the exception to the original device and phone/third-party subject.
    input: DeviceLimitContext & {
      readonly phone_hmac: string | null;
      readonly third_party_digest: string | null;
    },
  ) => Promise<boolean>;
  // TODO(规划/11 §2.3): BR-INV-14 same-transaction source=register log — blocked on level_change_logs table task.
  readonly recordInitialLevel?: (
    trx: Transaction<DB>,
    input: {
      readonly app_id: string;
      readonly user_id: string;
      readonly level: UserLevel;
      readonly source: 'register';
    },
  ) => Promise<void>;
}
export interface DeviceRegistrationRecord {
  readonly app_id: string;
  readonly device_hash: string;
  readonly user_id: string;
  readonly created_at: Date;
  readonly merged_into_user_id: string | null;
}
// Constants represented as a type + throwing accessor during the test phase (no const allowed).
// Implementation publishes these same values as constants via identity/index.ts too.
// Suggested values: users.phone (both crypto contexts), avatar:default; tests do not fix values.
export interface RegistrationConstants {
  readonly PHONE_BLIND_INDEX_CONTEXT: string;
  readonly PHONE_CIPHER_CONTEXT: string;
  readonly DEFAULT_AVATAR: string;
}
export function registrationConstants(): RegistrationConstants {
  throw new Error('NotImplemented: registrationConstants');
}
export function createRegistrationService(options: RegistrationOptions): RegistrationService {
  void options;
  throw new Error('NotImplemented: createRegistrationService');
}
// Seed format: one word per line, blank lines ignored, # prefixes comments.
// Match invite_code by case-insensitive substring; the header marks replacement by the word-bank task.
export function createDefaultInviteCodeFilter(): SensitiveWords {
  throw new Error('NotImplemented: createDefaultInviteCodeFilter');
}
export function countDeviceRegistrations(
  records: readonly DeviceRegistrationRecord[],
  scope: { readonly app_id: string; readonly device_hash: string },
  now: Date,
  mergeTombstoneDedupe: boolean,
): number {
  void records;
  void scope;
  void now;
  void mergeTombstoneDedupe;
  throw new Error('NotImplemented: countDeviceRegistrations');
}
