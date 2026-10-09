import type { RootLogger } from '../../platform/index.ts';
import type { SmsRisk } from '../../risk/index.ts';
import type { RegistrationOptions } from './registration.ts';
import type { SmsHooks } from './sms-codes.ts';

/** identity owns the pooled lookup of devices by BOTH app_id and device_id. */
export interface SmsDeviceHashReader {
  deviceHashOf(appId: string, deviceId: string): Promise<string | null>;
}
export interface SmsRiskPorts {
  readonly smsHooks: Required<Pick<SmsHooks, 'deviceQuota' | 'afterAccepted'>>;
  readonly registration: Required<Pick<RegistrationOptions, 'afterRegistered'>>;
}
export interface SmsRiskPortsOptions {
  readonly risk: SmsRisk;
  readonly devices: SmsDeviceHashReader;
  readonly logger: RootLogger;
}
export function createSmsRiskPorts(options: SmsRiskPortsOptions): SmsRiskPorts {
  void options;
  throw new Error('NotImplemented: createSmsRiskPorts');
}
