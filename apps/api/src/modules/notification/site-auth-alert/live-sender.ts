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
//     on an open breaker → rejected (B1-12w's mapping); send never rejects;
//   - accepted → the BizId is written to notify_logs.sms_biz_id of the row with app_id = m.appId,
//     dedupe_key = m.outId and channel 'sms' (only that column: status, sent_at and row_version
//     stay as the site auth alert port left them), then accepted.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock, ResilienceRegistry, Scheduler, SmsConfig } from '../../platform/index.ts';
import type { AliyunSmsFetch } from '../sms/aliyun-channel.ts';
import type { RegisteredTemplateResolver } from '../sms/registered-template.ts';
import type { TemplateSmsSender } from './service.ts';

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
}

export function createLiveTemplateSmsSender(deps: LiveTemplateSmsSenderDeps): TemplateSmsSender {
  void deps;
  throw new Error('NotImplemented: createLiveTemplateSmsSender');
}
