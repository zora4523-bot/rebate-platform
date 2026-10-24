// B1-12w · The entry's verification code sender (D10-315). app.module hands the result to
// identity's SmsSender port.
//
// createEntrySmsSender(deps):
//   - deps.sms undefined (local / test, or staging / prod without all four SMS_ variables) →
//     exactly what deps.fallback() returns (identity's createSmsSender: the fake, or the sender
//     that rejects every message with its startup warn).
//   - Otherwise resilience createSmsSender with primary = createAliyunSmsChannel (credentials of
//     the config; resolveTemplate knows only 'SMS_CODE' → { signName, templateCode:
//     verifyCodeTemplate }), no backup, a provider switch that always reads null; wrapped in
//     createVerifyCodeSmsSender.
import type { Clock, ResilienceRegistry, Scheduler, SmsConfig } from '../../platform/index.ts';
import type { AliyunSmsFetch } from './aliyun-channel.ts';
import type { VerifyCodeSmsSender } from './verify-code-sender.ts';

export { createAliyunSmsChannel } from './aliyun-channel.ts';
export type {
  AliyunSmsChannelDeps,
  AliyunSmsFetch,
  AliyunSmsFetchInit,
  AliyunSmsFetchResponse,
  AliyunSmsTemplate,
} from './aliyun-channel.ts';
export { createVerifyCodeSmsSender } from './verify-code-sender.ts';
export type {
  VerifyCodeDelivery,
  VerifyCodeMessage,
  VerifyCodePurpose,
  VerifyCodeSmsSender,
  VerifyCodeSmsSenderDeps,
} from './verify-code-sender.ts';

export interface EntrySmsSenderDeps {
  readonly sms: SmsConfig | undefined;
  readonly fallback: () => VerifyCodeSmsSender;
  readonly registry: ResilienceRegistry;
  readonly scheduler: Scheduler;
  readonly fetch: AliyunSmsFetch;
  readonly clock: Clock;
  readonly nonce: () => string;
  readonly messageId: () => string;
}

export function createEntrySmsSender(deps: EntrySmsSenderDeps): VerifyCodeSmsSender {
  void deps;
  throw new Error('NotImplemented: createEntrySmsSender');
}
