import type { Clock, FieldCrypto, RedisHandle, RootLogger } from '../../platform/index.ts';
import type { RateLimitConfigReader } from './rate-limit.ts';

/** B1-03f: identity calls these ports before issuance and after the database outcome. */
export interface DeviceRegistrationReservation {
  readonly appId: string;
  readonly ipDigest: string;
  readonly token: string;
}

export type DeviceRegistrationAdmission =
  | { readonly code: 0; readonly reservation: DeviceRegistrationReservation }
  | { readonly code: 42901; readonly retryAfterSec: number };

export interface DeviceRegistrationRisk {
  reserve(input: { appId: string; clientIp: string }): Promise<DeviceRegistrationAdmission>;
  release(reservation: DeviceRegistrationReservation): Promise<void>;
  /** Keep the reservation while checking; release only on confirmed absence, never on error. */
  reconcile(
    reservation: DeviceRegistrationReservation,
    deviceId: string,
    exists: (deviceId: string) => Promise<boolean>,
  ): Promise<void>;
  recordSuccess(input: { appId: string; deviceHash: string; deviceId: string }): Promise<void>;
}

export interface DeviceRegistrationRiskOptions {
  readonly clock: Clock;
  readonly redis: RedisHandle | null;
  readonly logger: RootLogger;
  /** Existing B1-03e configValue boundary; content is assembled outside risk. */
  readonly config: RateLimitConfigReader;
  readonly crypto: Pick<FieldCrypto, 'blindIndex'>;
}

export function createDeviceRegistrationRisk(
  options: DeviceRegistrationRiskOptions,
): DeviceRegistrationRisk {
  void options;
  throw new Error('NotImplemented: createDeviceRegistrationRisk');
}
