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
//   - B1-12y: with deps.resolver, 'SMS_CODE' is looked up there by the message's app_id instead
//     (the resolver holds the deployment fallback); undefined → rejected, no request.
import type { Clock, ResilienceRegistry, Scheduler, SmsConfig } from '../../platform/index.ts';
import { createSmsSender } from '../resilience/index.ts';
import { createAliyunSmsChannel, type AliyunSmsFetch } from './aliyun-channel.ts';
import type { RegisteredTemplateResolver } from './registered-template.ts';
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
export { createRegisteredTemplateResolver } from './registered-template.ts';
export type {
  RegisteredTemplateQuery,
  RegisteredTemplateResolver,
  RegisteredTemplateResolverDeps,
} from './registered-template.ts';

export interface EntrySmsSenderDeps {
  readonly sms: SmsConfig | undefined;
  /** B1-12y: the lookup of 'SMS_CODE' by app (registration, else the deployment's fallback). */
  readonly resolver?: RegisteredTemplateResolver;
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
    resolveTemplate: (template, message) => {
      if (template !== VERIFY_CODE_TEMPLATE) return undefined;
      // B1-12y: by the message's app (registration, else the deployment fallback the resolver
      // holds); undefined → rejected, the entry never stands in with the deployment itself.
      const resolver = deps.resolver;
      if (resolver === undefined) return verifyCode;
      return resolver.resolve({ appId: message.app_id, code: VERIFY_CODE_TEMPLATE });
    },
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
