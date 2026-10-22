import { createHash, createHmac } from 'node:crypto';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import { createAliyunAcs3Signer } from '../../../../apps/api/src/modules/agent/guard/review/sign.ts';
import type { AliyunSignRequest } from '../../../../apps/api/src/modules/agent/guard/review/index.ts';
import { credentials, endpoint } from './kit.ts';

// Independent oracle, per https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
// The RPC request has URI '/' and no query. Never import canonicalization/hash helpers from SUT.
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

it.each([
  '',
  'Service=llm_query_moderation&ServiceParameters=%7B%22content%22%3A%22%E6%9D%AF%22%7D',
  '中文 & + / 🙂',
])('[AC-B3-03m#4] ACS3 请求头与独立 SHA256/HMAC 一致且不修改请求：%j', async (body) => {
  const request: AliyunSignRequest = Object.freeze({
    endpoint,
    method: 'POST',
    body,
    action: 'TextModerationPlus',
    version: '2022-03-02',
    headers: Object.freeze({
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      'X-Acs-Z-Test': ' trim-me ',
      Accept: 'application/json',
    }),
  });
  const before = JSON.stringify(request);
  const sign = createAliyunAcs3Signer({
    clock: new FixedClock('2026-10-22T03:04:05.678Z'),
    nonce: () => 'synthetic-fixed-nonce',
  });
  const result = await sign(request, credentials, new AbortController().signal);
  const headers = Object.fromEntries(
    Object.entries(result).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const expected: Record<string, string> = {
    'content-type': request.headers['Content-Type']!,
    host: 'review.example.invalid',
    'x-acs-action': 'TextModerationPlus',
    'x-acs-content-sha256': sha256(body),
    'x-acs-date': '2026-10-22T03:04:05Z',
    'x-acs-signature-nonce': 'synthetic-fixed-nonce',
    'x-acs-version': '2022-03-02',
    'x-acs-z-test': 'trim-me',
  };
  const names = Object.keys(expected).sort();
  const canonicalHeaders = names.map((name) => `${name}:${expected[name]}\n`).join('');
  const canonical = ['POST', '/', '', canonicalHeaders, names.join(';'), sha256(body)].join('\n');
  const toSign = `ACS3-HMAC-SHA256\n${sha256(canonical)}`;
  const signature = createHmac('sha256', credentials.accessKeySecret)
    .update(toSign, 'utf8')
    .digest('hex');
  expect(headers['authorization']).toBe(
    `ACS3-HMAC-SHA256 Credential=${credentials.accessKeyId},SignedHeaders=${names.join(';')},Signature=${signature}`,
  );
  for (const name of [
    'host',
    'x-acs-action',
    'x-acs-version',
    'x-acs-date',
    'x-acs-signature-nonce',
    'x-acs-content-sha256',
  ])
    expect(headers[name]).toBe(expected[name]);
  expect(JSON.stringify(request)).toBe(before);
  expect(JSON.stringify(result)).not.toContain(credentials.accessKeySecret);
});

it('[AC-B3-03m#5] 每次签名使用注入的新时间和 nonce', async () => {
  let call = 0;
  let now = 0;
  const dates = ['2026-10-22T00:00:00Z', '2026-10-22T00:00:01Z'];
  const sign = createAliyunAcs3Signer({
    clock: { now: () => new Date(dates[now]!) },
    nonce: () => `nonce-${call++}`,
  });
  const request: AliyunSignRequest = {
    endpoint,
    method: 'POST',
    body: 'Service=x',
    headers: {},
    action: 'TextModerationPlus',
    version: '2022-03-02',
  };
  const results = [];
  for (let index = 0; index < 2; index += 1) {
    now = index;
    results.push(
      Object.fromEntries(
        Object.entries(await sign(request, credentials, new AbortController().signal)).map(
          ([key, value]) => [key.toLowerCase(), value],
        ),
      ),
    );
  }
  expect(results.map((headers) => headers['x-acs-date'])).toEqual(dates);
  expect(results.map((headers) => headers['x-acs-signature-nonce'])).toEqual([
    'nonce-0',
    'nonce-1',
  ]);
  expect(results[0]?.['authorization']).not.toBe(results[1]?.['authorization']);
});
