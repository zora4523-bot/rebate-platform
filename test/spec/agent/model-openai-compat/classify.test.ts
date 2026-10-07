// 错误归类（BR-AI-14 细则「无模型降级」触发条件区分超时、429、5xx；09 CAP-X-07 百炼限流文案；
// 09 CAP-X-19「HTTP 429 也可能是余额不足（1113）或配额不足（1308），不能一律当限流重试」）。
// 内容拦截码未实测：默认为空，只有差异表登记后才归 content_refused。
import { expect, it } from 'vitest';
import {
  classifyFailure,
  quirksFor,
} from '../../../../apps/api/src/modules/agent/model-gateway/openai-compat/index.ts';

function errBody(message: string, code: string) {
  return { error: { message, type: 'synthetic_error', code } };
}

it('[BR-AI-14 无模型降级触发#1] 401、403 归 auth；400 归 bad_request；5xx 归 server（含非 JSON 正文）', () => {
  const q = quirksFor('qwen');
  expect(
    classifyFailure('qwen', { status: 401, body: errBody('合成', 'invalid_api_key') }, q),
  ).toBe('auth');
  expect(classifyFailure('qwen', { status: 403, body: errBody('合成', 'access_denied') }, q)).toBe(
    'auth',
  );
  expect(
    classifyFailure('glm', { status: 401, body: errBody('合成', '1000') }, quirksFor('glm')),
  ).toBe('auth');
  expect(
    classifyFailure('qwen', { status: 400, body: errBody('合成', 'invalid_parameter') }, q),
  ).toBe('bad_request');
  for (const status of [500, 502, 503, 504]) {
    expect(classifyFailure('qwen', { status, body: errBody('合成', 'internal') }, q)).toBe(
      'server',
    );
    expect(classifyFailure('glm', { status, body: 'upstream error' }, quirksFor('glm'))).toBe(
      'server',
    );
  }
});

it('[09 CAP-X-07 限流] 千问 429 带百炼三种限流文案都归 rate_limited', () => {
  const q = quirksFor('qwen');
  for (const message of [
    'Requests rate limit exceeded, please try again later.',
    'Allocated quota exceeded, please increase your quota limit.',
    'Request rate increased too quickly. To ensure system stability, please adjust your client logic.',
  ]) {
    expect(
      classifyFailure('qwen', { status: 429, body: errBody(message, 'synthetic_429') }, q),
    ).toBe('rate_limited');
  }
});

it('[09 CAP-X-19 429 区分] GLM 429 带业务码 1113 或 1308 归 quota_exhausted；其他业务码的 429 归 rate_limited', () => {
  const g = quirksFor('glm');
  expect(classifyFailure('glm', { status: 429, body: errBody('合成：余额不足', '1113') }, g)).toBe(
    'quota_exhausted',
  );
  expect(classifyFailure('glm', { status: 429, body: errBody('合成：配额不足', '1308') }, g)).toBe(
    'quota_exhausted',
  );
  expect(classifyFailure('glm', { status: 429, body: errBody('合成：并发过高', '1302') }, g)).toBe(
    'rate_limited',
  );
});

it('[BR-AI-14 无模型降级触发 429 兜底] 429 本身就是限流：千问未知文案、空正文、非 JSON 正文、null 都归 rate_limited；GLM 无 1113/1308 码的 429 同样', () => {
  const bodies: unknown[] = [
    errBody('合成：未登记的限流文案', 'synthetic_unknown'),
    '',
    'Too Many Requests',
    null,
  ];
  for (const body of bodies) {
    expect(classifyFailure('qwen', { status: 429, body }, quirksFor('qwen'))).toBe('rate_limited');
    expect(classifyFailure('glm', { status: 429, body }, quirksFor('glm'))).toBe('rate_limited');
  }
});

it('[BR-AI-14 无模型降级触发 4xx 兜底] 401/403 与 400 在空正文、非 JSON 正文时仍按状态码归类', () => {
  const q = quirksFor('qwen');
  for (const body of ['', 'Unauthorized', null]) {
    expect(classifyFailure('qwen', { status: 401, body }, q)).toBe('auth');
    expect(classifyFailure('qwen', { status: 403, body }, q)).toBe('auth');
    expect(classifyFailure('qwen', { status: 400, body }, q)).toBe('bad_request');
  }
});

it('[BR-AI-14 无模型降级触发#2] 超时、网络、中止分别归 timeout、network、aborted', () => {
  const q = quirksFor('qwen');
  expect(classifyFailure('qwen', { cause: 'timeout' }, q)).toBe('timeout');
  expect(classifyFailure('qwen', { cause: 'network' }, q)).toBe('network');
  expect(classifyFailure('qwen', { cause: 'aborted' }, q)).toBe('aborted');
});

it('[09 CAP-X-07 未实测] 内容拦截码默认为空：任何状态码都不归 content_refused；登记后该码归 content_refused', () => {
  const body = errBody('合成：内容不合规', 'synthetic_refusal');
  expect(quirksFor('qwen').contentRefusalCodes).toEqual([]);
  expect(quirksFor('glm').contentRefusalCodes).toEqual([]);
  for (const status of [400, 403, 429, 500]) {
    expect(classifyFailure('qwen', { status, body }, quirksFor('qwen'))).not.toBe(
      'content_refused',
    );
  }
  const registered = quirksFor('qwen', { contentRefusalCodes: ['synthetic_refusal'] });
  expect(classifyFailure('qwen', { status: 400, body }, registered)).toBe('content_refused');
  expect(
    classifyFailure(
      'qwen',
      { status: 400, body: errBody('合成', 'invalid_parameter') },
      registered,
    ),
  ).toBe('bad_request');
});
