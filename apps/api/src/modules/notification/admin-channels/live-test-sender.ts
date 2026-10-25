// B1-12z · The admin entry's sender of the console's SMS registration test messages (CT-24t
// adminRegisterNotifySms / adminRetestNotifySms; BR-TEXT-20 细则「短信渠道登记与后台渠道开关」;
// orchestrator ruling D10-335 ③).
//
// createNotifySmsTestSender(deps) picks one sender per entry process:
//   - APP_ENV local / test → createFakeNotifySmsTestSender (no network; tests script it);
//   - staging / prod with all four SMS_ variables → the B1-12w Aliyun SendSms channel on
//     notification's SMS failover (credentials of the deployment configuration only), with the
//     signature and template CODE carried by the message itself (the pending registration under
//     test is never resolved by code);
//   - staging / prod without them → every send answers 'rejected' (nothing can go out), announced
//     by one warn line at startup.
// Result mapping: accepted by the provider → 'accepted'; a clear refusal, a provider error, or an
// open breaker on every attempt → 'rejected' (50301); a timeout → 'unknown' (50401). The sender
// never throws for a channel failure. Nothing logs a phone number or a credential.
import type {
  AppEnv,
  Clock,
  ResilienceRegistry,
  RootLogger,
  Scheduler,
  SmsConfig,
} from '../../platform/index.ts';
import { createSmsSender, type SmsMessage, type SmsSendResult } from '../resilience/index.ts';
import {
  createAliyunSmsChannel,
  type AliyunSmsFetch,
  type AliyunSmsTemplate,
} from '../sms/aliyun-channel.ts';
import {
  createFakeNotifySmsTestSender,
  type NotifySmsTestResult,
  type NotifySmsTestSender,
} from './sms-test-sender.ts';

/** The template key the test messages carry through the failover (never resolved by code). */
const TEST_TEMPLATE = 'NOTIFY_SMS_TEST';

export interface NotifySmsTestSenderDeps {
  readonly appEnv: AppEnv;
  /** The deployment's SMS configuration; undefined when not all four variables are set. */
  readonly sms: SmsConfig | undefined;
  readonly logger: Pick<RootLogger, 'warn'>;
  readonly registry: () => ResilienceRegistry;
  readonly scheduler: () => Scheduler;
  readonly fetch: AliyunSmsFetch;
  readonly clock: Clock;
  readonly nonce: () => string;
  /** OutId of each test SMS. */
  readonly messageId: () => string;
}

function resultOf(result: SmsSendResult): NotifySmsTestResult {
  if (result.outcome === 'sent') return 'accepted';
  if (result.outcome === 'rejected') return 'rejected';
  return result.attempts.some((attempt) => attempt.result === 'timeout') ? 'unknown' : 'rejected';
}

export function createNotifySmsTestSender(deps: NotifySmsTestSenderDeps): NotifySmsTestSender {
  if (deps.appEnv === 'local' || deps.appEnv === 'test') {
    return createFakeNotifySmsTestSender(deps.appEnv);
  }
  const config = deps.sms;
  if (config === undefined) {
    deps.logger.warn({ app_env: deps.appEnv }, 'notify_sms_test_sender_unconfigured');
    return Object.freeze({ send: () => Promise.resolve<NotifySmsTestResult>('rejected') });
  }
  // The registration of each message in flight, handed to the channel with the message.
  const templates = new WeakMap<SmsMessage, AliyunSmsTemplate>();
  const primary = createAliyunSmsChannel({
    credentials: { accessKeyId: config.accessKeyId, accessKeySecret: config.accessKeySecret },
    resolveTemplate: (_template, message) => templates.get(message),
    fetch: deps.fetch,
    clock: deps.clock,
    nonce: deps.nonce,
  });
  const sms = createSmsSender({
    registry: deps.registry(),
    primary,
    providerSwitch: { current: () => Promise.resolve(null) },
    scheduler: deps.scheduler(),
  });
  return Object.freeze({
    async send(message) {
      const outgoing: SmsMessage = {
        app_id: message.appId,
        message_id: deps.messageId(),
        phone: message.phone,
        template: TEST_TEMPLATE,
        params: { ...message.params },
      };
      templates.set(outgoing, { signName: message.signName, templateCode: message.templateCode });
      try {
        return resultOf(await sms.send(outgoing));
      } catch {
        // The outcome is not known: the SMS may have gone out.
        return 'unknown';
      } finally {
        templates.delete(outgoing);
      }
    },
  } satisfies NotifySmsTestSender);
}
