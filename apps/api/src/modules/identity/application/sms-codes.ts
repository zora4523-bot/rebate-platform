import type { Clock, RedisHandle, RootLogger } from '../../platform/index.ts';

export type SmsPurpose = 'login' | 'bind' | 'step_up';
export type SmsDelivery = 'accepted' | 'rejected' | 'unknown';
export interface SmsMessage {
  readonly app_id: string;
  readonly phone: string;
  readonly purpose: SmsPurpose;
  readonly code: string;
}
export interface SmsSender {
  send(message: SmsMessage): Promise<SmsDelivery>;
}
export interface SmsRequest {
  readonly app_id: string;
  readonly phone: string;
  readonly purpose: SmsPurpose;
  readonly captcha_token?: string;
  readonly action?: string;
}
export type SmsResult =
  | {
      readonly code: 0;
      readonly data: { readonly resend_after_sec: number; readonly expires_in_sec: number };
    }
  | {
      readonly code: 20001;
      readonly data: { readonly fields: readonly string[]; readonly reason: 'phone_invalid' };
    }
  | {
      readonly code: 44001;
      readonly kind: 'blocked_prefix' | 'phone_blocklist';
      readonly data?: { readonly risk_msg_code: string };
    }
  | { readonly code: 44003 }
  | { readonly code: 42901; readonly retryAfterSec: number }
  | { readonly code: 50001 };
export interface SmsConfigReader {
  configValue(
    appId: string,
    key: string,
  ): Promise<{ readonly value: unknown; readonly version: number } | null>;
}
/** Ordered seams for B1-03d/g, after normalisation/prefix checks and before phone quota. */
export interface SmsHooks {
  readonly phoneBlocklist?: (
    request: SmsRequest,
  ) => Promise<Extract<SmsResult, { code: 44001 }> | null>;
  readonly captcha?: (request: SmsRequest) => Promise<Extract<SmsResult, { code: 44003 }> | null>;
  readonly deviceQuota?: (
    request: SmsRequest,
  ) => Promise<Extract<SmsResult, { code: 42901 }> | null>;
  readonly afterAccepted?: (request: SmsRequest) => Promise<void>;
}
export interface SmsCodeOptions {
  readonly clock: Clock;
  readonly redis: RedisHandle;
  readonly sender: SmsSender;
  readonly config: SmsConfigReader;
  readonly logger: RootLogger;
  readonly hmac: (text: string) => string;
  readonly hooks?: SmsHooks;
}
export interface SmsCodeService {
  send(request: SmsRequest): Promise<SmsResult>;
  verifyAndConsume(
    request: Pick<SmsMessage, 'app_id' | 'phone' | 'purpose' | 'code'>,
  ): Promise<{ readonly code: 0 | 20002 | 20003 }>;
}

export function createSmsCodeService(options: SmsCodeOptions): SmsCodeService {
  void options;
  throw new Error('NotImplemented: createSmsCodeService');
}
