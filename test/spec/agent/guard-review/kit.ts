// 全部为合成数据；不是真实阿里云录制，不联网、不使用真实 Key。
import { vi } from 'vitest';
import {
  createAliyunInputReview,
  createAliyunOutputReview,
} from '../../../../apps/api/src/modules/agent/guard/review/index.ts';
import type {
  AliyunReviewDeps,
  AliyunReviewFetchInit,
  AliyunReviewFetchResponse,
} from '../../../../apps/api/src/modules/agent/guard/review/index.ts';
import { ManualScheduler, flush, observe } from '../../platform/http/kit.ts';

export { flush, observe };
export const SIDES = ['input', 'output'] as const;
export type Side = (typeof SIDES)[number];
export const ENDPOINT = 'https://guard.example.invalid/';
export const CONTENT = '合成审核正文：甲&乙=丙+丁%\n"引号"与表情🙂。';
export const CREDENTIALS = {
  accessKeyId: 'synthetic-access-id',
  accessKeySecret: 'synthetic-access-secret',
  securityToken: 'synthetic-security-token',
};
export const SIGNED_HEADERS = { authorization: 'synthetic-signature-only' };

/** 文档字段上的合成最小响应，不冒充平台录制。 */
export function verdictBody(riskLevel: string): unknown {
  return { Code: 200, Data: { RiskLevel: riskLevel }, RequestId: 'synthetic-request-id' };
}

export function response(body: unknown, status = 200): AliyunReviewFetchResponse {
  return { status, text: () => Promise.resolve(JSON.stringify(body)) };
}

export function fixture(side: Side, overrides: Partial<AliyunReviewDeps> = {}) {
  const scheduler = new ManualScheduler();
  const calls: { url: string; init: AliyunReviewFetchInit }[] = [];
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const credentials = vi.fn(() => CREDENTIALS);
  const sign = vi.fn<AliyunReviewDeps['sign']>(() => Promise.resolve(SIGNED_HEADERS));
  const timeoutMs = vi.fn(() => 1000); // BR-AI-18 默认值，配置层以回调传入。
  const fetch: AliyunReviewDeps['fetch'] = (url, init) => {
    calls.push({ url, init });
    return overrides.fetch === undefined
      ? Promise.resolve(response(verdictBody('none')))
      : overrides.fetch(url, init);
  };
  const deps: AliyunReviewDeps = {
    scheduler,
    timeoutMs,
    credentials,
    sign,
    endpoint: ENDPOINT,
    logger,
    ...overrides,
    fetch,
  };
  // 工厂在测试体内执行，骨架的 NotImplemented 直接使每条用例先红。
  const port = side === 'input' ? createAliyunInputReview(deps) : createAliyunOutputReview(deps);
  return { port, scheduler, calls, logger, sign, credentials, timeoutMs };
}

export function requestContent(init: AliyunReviewFetchInit): unknown {
  const form = new URLSearchParams(init.body);
  const params: unknown = JSON.parse(form.get('ServiceParameters') ?? 'null');
  return params;
}
