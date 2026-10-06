// SMS sender adapters of the SmsSender port (BR-ID-05; 规划/11 §8; orchestrator ruling B1-02e §9.3
// #6–#8). The port lives in identity; the real provider adapter (Aliyun) is a later task and moves
// to notification together with this file.
//
// - createFakeSmsSender: local and test only (any other APP_ENV throws). By default every message
//   is accepted; enqueueResult() queues the outcome of the next sends (accepted / rejected /
//   unknown). Accepted and unknown messages go to an in-process outbox, which tests (and local
//   development) read instead of a fixed code (ruling §9.5 #9). Nothing is logged.
// - createSmsSender: what the entry provides under smsSenderToken(): the fake in local / test; in
//   staging / prod, until the provider adapter lands, a sender that rejects every message (nothing
//   is sent, the reservation is released, the request answers 50001); the entry logs one warn
//   `sms_sender_unconfigured` when it builds that sender.
// - smsCredentialEnvNames: the credential variables the SMS adapter reads, all SMS_-prefixed;
//   loadConfig refuses to start local / test when one is set (platform/config/credential-env.ts
//   holds the list, because loadConfig runs before any module).
//
// Also compiled by the `test` project: erasable syntax only, `import type` for types, `.ts`
// relative imports, no decorators.
import { SMS_CREDENTIAL_ENV_NAMES, type RootLogger } from '../../platform/index.ts';
import type { SmsDelivery, SmsMessage, SmsSender } from '../application/sms-codes.ts';

export interface FakeSmsSender extends SmsSender {
  enqueueResult(result: SmsDelivery): void;
  outbox(): readonly SmsMessage[];
}

/** Process-owned sender token; tests read the HTTP outbox through it. */
const SMS_SENDER = Symbol('SMS_SENDER');
/** A long local session must not grow the outbox without bound. */
const OUTBOX_LIMIT = 1000;
const DELIVERIES: ReadonlySet<unknown> = new Set(['accepted', 'rejected', 'unknown']);

function isFakeEnvironment(appEnv: string): boolean {
  return appEnv === 'local' || appEnv === 'test';
}

/** Only local/test may construct this adapter; default delivery outcome is accepted. */
export function createFakeSmsSender(appEnv: string): FakeSmsSender {
  if (!isFakeEnvironment(appEnv)) {
    throw new Error('identity: the fake SMS sender runs only when APP_ENV is local or test');
  }
  const outcomes: SmsDelivery[] = [];
  const sent: SmsMessage[] = [];
  return Object.freeze({
    async send(message: SmsMessage): Promise<SmsDelivery> {
      const outcome = outcomes.shift() ?? 'accepted';
      if (outcome !== 'rejected') {
        sent.push(
          Object.freeze({
            app_id: message.app_id,
            phone: message.phone,
            purpose: message.purpose,
            code: message.code,
          }),
        );
        if (sent.length > OUTBOX_LIMIT) sent.splice(0, sent.length - OUTBOX_LIMIT);
      }
      return outcome;
    },
    enqueueResult(result: SmsDelivery): void {
      if (!DELIVERIES.has(result)) throw new TypeError('identity: unknown SMS delivery outcome');
      outcomes.push(result);
    },
    outbox(): readonly SmsMessage[] {
      return Object.freeze([...sent]);
    },
  });
}

/**
 * The entry's sender: the fake in local / test; elsewhere, until the provider adapter exists, a
 * sender that definitely rejects (nothing is sent), announced once with a warn at startup.
 */
export function createSmsSender(appEnv: string, logger: Pick<RootLogger, 'warn'>): SmsSender {
  if (isFakeEnvironment(appEnv)) return createFakeSmsSender(appEnv);
  logger.warn({ app_env: appEnv }, 'sms_sender_unconfigured');
  return Object.freeze({ send: async (): Promise<SmsDelivery> => 'rejected' });
}

export function smsCredentialEnvNames(): readonly string[] {
  return SMS_CREDENTIAL_ENV_NAMES;
}

/** Stable Nest token for the process-owned sender, also used to inspect the HTTP test outbox. */
export function smsSenderToken(): symbol {
  return SMS_SENDER;
}
