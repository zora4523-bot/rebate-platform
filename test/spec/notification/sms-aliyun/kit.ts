// 共用夹具（B1-12w；编排裁定 D10-315、D10-316）：阿里云 SendSms 通道、验证码发送与装配入口的规则测试。
// - HTTP 只走注入的假 fetch：记录每个请求，按脚本返回应答、抛错，或挂起到 signal 中止；全局 fetch
//   换成一调用就失败的替身，接线错误不会出网。不 listen、不连库。
// - 凭据是明显的假值；签名用 ../../platform/aliyun-signature/oracle.ts 的独立 oracle 复算。
// - 时间：墙钟只用 FixedClock；治理层的时限只走手动 Scheduler（platform/http 规则测试的 ManualScheduler）。
import { inspect } from 'node:util';
import { vi } from 'vitest';
import type {
  AliyunSmsFetch,
  AliyunSmsFetchInit,
} from '../../../../apps/api/src/modules/notification/sms/index.ts';
import {
  acs3Oracle,
  lowerHeaders,
  signedRequestHeaders,
} from '../../platform/aliyun-signature/oracle.ts';

export { ManualScheduler, flush, observe } from '../../platform/http/kit.ts';
export type { Observed } from '../../platform/http/kit.ts';
export { lowerHeaders, sha256 } from '../../platform/aliyun-signature/oracle.ts';

export const SMS_PAIR = { accessKeyId: 'test-sms-id', accessKeySecret: 'test-sms-sentinel-value' };
export const DEFAULT_ENDPOINT = 'https://dysmsapi.aliyuncs.com/';
/** FixedClock 的时刻与签名头里应有的 x-acs-date（去掉毫秒）。 */
export const AT = '2026-10-24T01:02:03.456Z';
export const AT_ACS = '2026-10-24T01:02:03Z';

export type Reply = { readonly status: number; readonly body: string } | 'throw' | 'hang';

export function json(status: number, value: unknown): Reply {
  return { status, body: JSON.stringify(value) };
}

export const OK_REPLY = json(200, {
  Code: 'OK',
  Message: 'OK',
  BizId: 'biz-synthetic-1',
  RequestId: 'req-synthetic-1',
});

export interface SentRequest {
  readonly url: string;
  readonly init: AliyunSmsFetchInit;
}

export function transport(replies: readonly Reply[]) {
  const unexpectedFetch = vi.fn(async () => {
    throw new Error('unexpected global fetch: use the injected synthetic transport');
  });
  vi.stubGlobal('fetch', unexpectedFetch);
  const calls: SentRequest[] = [];
  const fetch = vi.fn<AliyunSmsFetch>(async (url, init) => {
    calls.push({ url, init });
    const reply = replies[calls.length - 1];
    if (reply === undefined) throw new Error('unscripted synthetic request');
    if (reply === 'throw') throw new Error('synthetic transport unavailable');
    if (reply === 'hang') {
      return new Promise<never>((_resolve, reject) => {
        const stop = () => {
          reject(new Error('synthetic request aborted'));
        };
        if (init.signal.aborted) stop();
        else init.signal.addEventListener('abort', stop, { once: true });
      });
    }
    return { status: reply.status, text: async () => reply.body };
  });
  return { fetch, calls, unexpectedFetch };
}

/** 查询参数：名字 → 值，外加参数个数（查出重名）。 */
export function queryOf(url: string): {
  readonly params: Readonly<Record<string, string>>;
  readonly count: number;
} {
  const entries = [...new URL(url).searchParams.entries()];
  return { params: Object.fromEntries(entries), count: entries.length };
}

/** 去掉查询串的地址。 */
export function baseOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

/** 按实际发出的请求，用独立 oracle 复算 Authorization。 */
export function recomputedAuthorization(
  sent: SentRequest,
  pair: { readonly accessKeyId: string; readonly accessKeySecret: string },
): string {
  const url = new URL(sent.url);
  return acs3Oracle({
    method: sent.init.method,
    host: url.host,
    path: url.pathname,
    query: [...url.searchParams.entries()],
    headers: signedRequestHeaders(sent.init.headers),
    body: sent.init.body ?? '',
    accessKeyId: pair.accessKeyId,
    hmacKey: pair.accessKeySecret,
  }).authorization;
}

/** 发出的请求里与 SendSms 相关的部分（不含 Authorization 本身）。 */
export function requestView(sent: SentRequest) {
  const headers = lowerHeaders(sent.init.headers);
  return {
    method: sent.init.method,
    base: baseOf(sent.url),
    body: sent.init.body ?? '',
    query: queryOf(sent.url),
    action: headers['x-acs-action'],
    version: headers['x-acs-version'],
    date: headers['x-acs-date'],
    payload: headers['x-acs-content-sha256'],
  };
}

/** 错误或输出的完整文本（含 cause 与自有属性），用来断言不含 AccessKeySecret。 */
export function fullText(value: unknown): string {
  return inspect(value, { depth: 10, showHidden: true });
}
