import type { Clock, FieldCrypto, RedisHandle, RootLogger } from '../../platform/index.ts';
import type { RateLimitConfigReader } from './rate-limit.ts';

/** BR-ID-05 / B1-03g: identity resolves device_hash before calling this port. */
export interface SmsRiskRequest {
  readonly appId: string;
  readonly deviceHash: string;
  /** Already normalized by identity; stored only as a keyed digest. */
  readonly phone: string;
  readonly clientIp: string;
}
export type SmsRiskAdmission =
  { readonly code: 0 } | { readonly code: 42901; readonly retryAfterSec: number };
export interface SmsRisk {
  /** IP checks precede the atomic device admission; admission is never refunded. */
  admit(input: SmsRiskRequest): Promise<SmsRiskAdmission>;
  /** Called once after accepted OR unknown delivery, never for explicit rejection. */
  recordAccepted(input: { appId: string; clientIp: string }): Promise<void>;
  /** All register_method values count; called by identity before commit. */
  recordRegistered(input: { appId: string; clientIp: string; userId: string }): Promise<void>;
}
export interface SmsRiskOptions {
  readonly clock: Clock;
  readonly redis: RedisHandle | null;
  readonly logger: RootLogger;
  readonly config: RateLimitConfigReader;
  readonly crypto: Pick<FieldCrypto, 'blindIndex'>;
}
export function createSmsRisk(options: SmsRiskOptions): SmsRisk {
  void options;
  throw new Error('NotImplemented: createSmsRisk');
}
