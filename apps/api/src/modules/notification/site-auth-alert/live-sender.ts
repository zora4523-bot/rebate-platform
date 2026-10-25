// B1-12y · The site union authorization alert SMS on the real Aliyun channel (BR-TEXT-20 站长告警
// 短信, BR-ID-24; orchestrator ruling D10-316 ①; 04 §3.2 notify_logs.sms_biz_id). Implements
// TemplateSmsSender of ./service.ts; app.module uses it on staging / prod when loadConfig read all
// SMS_ variables, in place of createTemplateSmsSender's rejecting sender (local / test keep the
// fake).
//
// createLiveTemplateSmsSender(deps): resilience createSmsSender with primary =
// createAliyunSmsChannel (credentials of deps.sms; the signature name and template CODE of each
// message from deps.resolver by { appId, code: template }, variant default), no backup, a provider
// switch that always reads null. send(m):
//   - SendSms with PhoneNumbers = m.phone, TemplateParam = JSON of m.params, OutId = m.outId
//     (messageId() when m has none);
//   - no in-use registration (resolver undefined) or a clear refusal by the provider → rejected,
//     nothing written; a timeout or a channel failure → unknown, never sent again; every attempt
//     on an open breaker → rejected (B1-12w's mapping); the channel never makes send reject, only
//     a failed registration lookup does (before any request: the port hands the alert back for a
//     retry, nothing was sent);
//   - accepted → the BizId is written to notify_logs.sms_biz_id of the row with app_id = m.appId,
//     dedupe_key = m.outId and channel 'sms' (only that column: status, sent_at and row_version
//     stay as the site auth alert port left them), then accepted (a failed write is logged with
//     app_id and outId, and the result is still accepted: the SMS is out).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type {
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
import type { RegisteredTemplateResolver } from '../sms/registered-template.ts';
import type { TemplateSmsMessage, TemplateSmsResult, TemplateSmsSender } from './service.ts';

export interface LiveTemplateSmsSenderDeps {
  /** AccessKey of the deployment (never in the console or the database). */
  readonly sms: SmsConfig;
  readonly resolver: RegisteredTemplateResolver;
  readonly db: Kysely<DB>;
  readonly registry: ResilienceRegistry;
  readonly scheduler: Scheduler;
  readonly fetch: AliyunSmsFetch;
  readonly clock: Clock;
  readonly nonce: () => string;
  /** OutId of a message without outId. */
  readonly messageId: () => string;
  /** A BizId that could not be written is logged here (app_id and outId only, never a phone). */
  readonly logger?: Pick<RootLogger, 'warn'>;
}

/** B1-12w's mapping: an open breaker on every attempt sent nothing, so nothing can arrive. */
function delivery(result: SmsSendResult): TemplateSmsResult {
  if (result.outcome === 'sent') return 'accepted';
  if (result.outcome === 'rejected') return 'rejected';
  if (result.attempts.length > 0 && result.attempts.every((a) => a.result === 'circuit_open')) {
    return 'rejected';
  }
  return 'unknown';
}

export function createLiveTemplateSmsSender(deps: LiveTemplateSmsSenderDeps): TemplateSmsSender {
  const db = deps.db.withSchema('app');
  // The registration of each message in flight, looked up before the channel is called (a failed
  // lookup throws to the caller, which hands the alert back for a retry: nothing was sent).
  const templates = new WeakMap<SmsMessage, AliyunSmsTemplate>();
  const primary = createAliyunSmsChannel({
    credentials: { accessKeyId: deps.sms.accessKeyId, accessKeySecret: deps.sms.accessKeySecret },
    resolveTemplate: (_template, message) => templates.get(message),
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

  const sender: TemplateSmsSender = {
    async send(m: TemplateSmsMessage): Promise<TemplateSmsResult> {
      const template = await deps.resolver.resolve({ appId: m.appId, code: m.template });
      // No in-use registration (or the channel is closed / not ready): not sent.
      if (template === undefined) return 'rejected';
      const message: SmsMessage = {
        app_id: m.appId,
        message_id: m.outId ?? deps.messageId(),
        phone: m.phone,
        template: m.template,
        params: { ...m.params },
      };
      templates.set(message, template);
      let result: SmsSendResult;
      try {
        result = await sms.send(message);
      } catch {
        return 'unknown';
      } finally {
        templates.delete(message);
      }
      const outcome = delivery(result);
      if (result.outcome === 'sent' && m.outId !== undefined) {
        try {
          await db
            .updateTable('notify_logs')
            .set({ sms_biz_id: result.providerMessageId })
            .where('app_id', '=', m.appId)
            .where('dedupe_key', '=', m.outId)
            .where('channel', '=', 'sms')
            .execute();
        } catch (error) {
          // The SMS is out: never report it as not sent (that would send it again).
          deps.logger?.warn(
            {
              app_id: m.appId,
              out_id: m.outId,
              error_name: error instanceof Error ? error.name : typeof error,
            },
            'template_sms_biz_id_unsaved',
          );
        }
      }
      return outcome;
    },
  };
  return Object.freeze(sender);
}
