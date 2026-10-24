// B1-12w · Verification code SMS (BR-ID-05) on notification's SMS failover: the shape of
// identity's SmsSender port (not imported from identity; app.module hands it over).
//
// Exports VERIFY_CODE_TEMPLATE = 'SMS_CODE' (the template key every purpose shares) and
// VERIFY_CODE_TEMPLATE_TEXT = '您的动态码为：${code}，5分钟内有效，请勿泄露！' (a plain string; its
// lifetime is SMS_CODE_LIFETIME_SECONDS of identity, its only variable is `code`).
//
// send({ app_id, phone, purpose, code }) hands sms.send
//   { app_id, message_id: messageId(), phone, template: 'SMS_CODE', params: { code } }
// and maps the result: `sent` → accepted; `rejected` → rejected; `failed` whose attempts are all
// circuit_open → rejected (nothing left the process); any other `failed` (a timeout or a channel
// error) → unknown; sms.send throwing → unknown.
import type { SmsMessage, SmsSendResult } from '../resilience/index.ts';

/** Template key every purpose shares (the caller maps it to the provider's template CODE). */
export const VERIFY_CODE_TEMPLATE = 'SMS_CODE';

/** The registered template text (BR-ID-05: 5 minutes = SMS_CODE_LIFETIME_SECONDS). Not a template literal. */
export const VERIFY_CODE_TEMPLATE_TEXT = '您的动态码为：${code}，5分钟内有效，请勿泄露！';

export type VerifyCodePurpose = 'login' | 'bind' | 'step_up';

export interface VerifyCodeMessage {
  readonly app_id: string;
  readonly phone: string;
  readonly purpose: VerifyCodePurpose;
  readonly code: string;
}

export type VerifyCodeDelivery = 'accepted' | 'rejected' | 'unknown';

/** Structurally identity's SmsSender. */
export interface VerifyCodeSmsSender {
  send(message: VerifyCodeMessage): Promise<VerifyCodeDelivery>;
}

export interface VerifyCodeSmsSenderDeps {
  readonly sms: { send(message: SmsMessage): Promise<SmsSendResult> };
  readonly messageId: () => string;
}

function delivery(result: SmsSendResult): VerifyCodeDelivery {
  if (result.outcome === 'sent') return 'accepted';
  if (result.outcome === 'rejected') return 'rejected';
  // Every attempt hit an open breaker: nothing left the process, so no SMS can arrive.
  if (result.attempts.length > 0 && result.attempts.every((a) => a.result === 'circuit_open')) {
    return 'rejected';
  }
  return 'unknown';
}

export function createVerifyCodeSmsSender(deps: VerifyCodeSmsSenderDeps): VerifyCodeSmsSender {
  return {
    async send(message) {
      const sms: SmsMessage = {
        app_id: message.app_id,
        message_id: deps.messageId(),
        phone: message.phone,
        template: VERIFY_CODE_TEMPLATE,
        params: { code: message.code },
      };
      try {
        return delivery(await deps.sms.send(sms));
      } catch {
        return 'unknown';
      }
    },
  };
}
