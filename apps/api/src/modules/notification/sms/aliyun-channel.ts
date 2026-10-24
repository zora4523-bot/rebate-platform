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
import { createAliyunAcs3Signer } from '../../platform/index.ts';
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

const DEFAULT_ENDPOINT = 'https://dysmsapi.aliyuncs.com/';
const ACTION = 'SendSms';
const VERSION = '2017-05-25';

/** A channel failure; its message names the cause only (never a credential or a response body). */
class AliyunSmsChannelError extends Error {
  constructor(reason: string) {
    super(`aliyun sms: ${reason}`);
    this.name = 'AliyunSmsChannelError';
  }
}

function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function field(value: unknown, name: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[name];
}

export function createAliyunSmsChannel(deps: AliyunSmsChannelDeps): SmsChannel {
  const endpoint = deps.endpoint ?? DEFAULT_ENDPOINT;
  const sign = createAliyunAcs3Signer({ clock: deps.clock, nonce: deps.nonce });
  return {
    provider: 'aliyun',
    async send(message, signal) {
      const template = deps.resolveTemplate(message.template);
      if (template === undefined) return { status: 'rejected' };

      // RFC 3986 encoding (spaces as %20, not '+'), so the provider decodes exactly what was signed.
      const query = (
        [
          ['PhoneNumbers', message.phone],
          ['SignName', template.signName],
          ['TemplateCode', template.templateCode],
          ['TemplateParam', JSON.stringify(message.params)],
          ['OutId', message.message_id],
        ] as const
      )
        .map(([name, value]) => `${percentEncode(name)}=${percentEncode(value)}`)
        .join('&');
      const url = new URL(endpoint);
      url.search = '';
      url.hash = '';
      const target = `${url.toString()}?${query}`;

      let headers: Readonly<Record<string, string>>;
      try {
        headers = await sign(
          {
            endpoint: target,
            method: 'POST',
            headers: {},
            body: '',
            action: ACTION,
            version: VERSION,
          },
          deps.credentials,
          signal,
        );
      } catch {
        throw new AliyunSmsChannelError('signing failed');
      }

      let status: number;
      let text: string;
      try {
        const response = await deps.fetch(target, {
          method: 'POST',
          headers: { ...headers },
          body: '',
          signal,
        });
        status = response.status;
        text = await response.text();
      } catch {
        // The transport error is dropped on purpose: it could echo request headers.
        throw new AliyunSmsChannelError(signal.aborted ? 'request aborted' : 'request failed');
      }

      const reply = parseJson(text);
      const code = field(reply, 'Code');
      if (status >= 200 && status < 300 && code === 'OK') {
        const bizId = field(reply, 'BizId');
        if (typeof bizId === 'string' && bizId !== '') {
          return { status: 'accepted', providerMessageId: bizId };
        }
        throw new AliyunSmsChannelError('accepted without BizId');
      }
      // 429 is a channel failure (throttling), not a refusal of this message.
      if (status < 500 && status !== 429 && typeof code === 'string' && code !== 'OK') {
        return { status: 'rejected' };
      }
      throw new AliyunSmsChannelError(`unexpected reply (HTTP ${String(status)})`);
    },
  };
}
