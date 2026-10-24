// B1-12w · Aliyun SendSms channel of notification's SMS failover (orchestrator rulings D10-315,
// D10-316). Returns the resilience `SmsChannel` port with provider id `aliyun`; the composite of
// ../resilience runs every send through its governor (timeout, breaker, no retry).
//
// send(message, signal):
//   - resolveTemplate(message.template) undefined → { status: 'rejected' }, no request. The
//     signature name and the template CODE come from the caller by template key (D10-316).
//   - Otherwise one POST to `endpoint` (default https://dysmsapi.aliyuncs.com/), ACS3-signed by
//     platform's createAliyunAcs3Signer, x-acs-action SendSms, x-acs-version 2017-05-25; the
//     parameters go in the query: PhoneNumbers = message.phone, SignName, TemplateCode,
//     TemplateParam = JSON.stringify(message.params), OutId = message.message_id; empty body;
//     `signal` is handed to fetch.
//   - HTTP 2xx, JSON Code 'OK' and a non-empty string BizId → { status: 'accepted',
//     providerMessageId: BizId }. HTTP < 500 with a string Code other than 'OK' → { status:
//     'rejected' }. Anything else (HTTP ≥ 500, not JSON, no Code, OK without BizId, fetch failed,
//     aborted) throws: a channel failure. No error and no output carries the AccessKeySecret.
import type { AliyunCredentials, Clock } from '../../platform/index.ts';
import type { SmsChannel } from '../resilience/index.ts';

export interface AliyunSmsTemplate {
  readonly signName: string;
  readonly templateCode: string;
}

export interface AliyunSmsFetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal: AbortSignal;
}

export interface AliyunSmsFetchResponse {
  readonly status: number;
  text(): Promise<string>;
}

export type AliyunSmsFetch = (
  url: string,
  init: AliyunSmsFetchInit,
) => Promise<AliyunSmsFetchResponse>;

export interface AliyunSmsChannelDeps {
  readonly credentials: AliyunCredentials;
  readonly resolveTemplate: (template: string) => AliyunSmsTemplate | undefined;
  readonly fetch: AliyunSmsFetch;
  readonly clock: Clock;
  readonly nonce: () => string;
  /** Full https URL of the SendSms endpoint; https://dysmsapi.aliyuncs.com/ when absent. */
  readonly endpoint?: string;
}

export function createAliyunSmsChannel(deps: AliyunSmsChannelDeps): SmsChannel {
  void deps;
  throw new Error('NotImplemented: createAliyunSmsChannel');
}
