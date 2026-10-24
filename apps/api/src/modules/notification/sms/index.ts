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
import { createSmsSender } from '../resilience/index.ts';
import { createAliyunSmsChannel, type AliyunSmsFetch } from './aliyun-channel.ts';
import {
  VERIFY_CODE_TEMPLATE,
  createVerifyCodeSmsSender,
  type VerifyCodeSmsSender,
} from './verify-code-sender.ts';

export { createAliyunSmsChannel } from './aliyun-channel.ts';
export type {
  AliyunSmsChannelDeps,
  AliyunSmsFetch,
  AliyunSmsFetchInit,
  AliyunSmsFetchResponse,
  AliyunSmsTemplate,
} from './aliyun-channel.ts';
export {
  VERIFY_CODE_TEMPLATE,
  VERIFY_CODE_TEMPLATE_TEXT,
  createVerifyCodeSmsSender,
} from './verify-code-sender.ts';
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
  const config = deps.sms;
  if (config === undefined) return deps.fallback();
  const verifyCode = Object.freeze({
    signName: config.signName,
    templateCode: config.verifyCodeTemplate,
  });
  const primary = createAliyunSmsChannel({
    credentials: { accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret },
    resolveTemplate: (template) => (template === VERIFY_CODE_TEMPLATE ? verifyCode : undefined),
    fetch: deps.fetch,
    clock: deps.clock,
    nonce: deps.nonce,
  });
  const sms = createSmsSender({
    registry: deps.registry,
    primary,
    providerSwitch: { current: () => Promise.resolve(null) },
    scheduler: deps.scheduler,
  });
  return createVerifyCodeSmsSender({ sms, messageId: deps.messageId });
}
