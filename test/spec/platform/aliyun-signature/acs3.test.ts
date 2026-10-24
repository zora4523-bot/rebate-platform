// 规则测试（B1-12w；编排裁定 D10-315 与补充 3）：ACS3-HMAC-SHA256 签名挪到 platform 共用，经
// platform 公共出口取得；agent 的 guard/review/sign.ts 改为再导出它（agent 行为不变）。
// 期望值逐字取自阿里云「V3 版本请求体&签名机制」的签名示例（编排者已取原文并本地复算一致）：
// https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
// 独立 oracle 见 ./oracle.ts。示例里的 64 位十六进制值各占一行，所在行不含 gitleaks 的关键词。
import { expect, it } from 'vitest';
import {
  FixedClock,
  createAliyunAcs3Signer,
  type AliyunSignRequest,
} from '../../../../apps/api/src/modules/platform/index.ts';
import * as agentSign from '../../../../apps/api/src/modules/agent/guard/review/sign.ts';
import type { AliyunSignRequest as AgentSignRequest } from '../../../../apps/api/src/modules/agent/guard/review/index.ts';
import { acs3Oracle, lowerHeaders, sha256 } from './oracle.ts';

// ---------- 文档签名示例 ----------
const DOC_ID = 'YourAccessKeyId';
const DOC_PAIR = { accessKeyId: DOC_ID, accessKeySecret: 'YourAccessKeySecret' };

const DOC_DATE = '2023-10-26T10:22:32Z';
const DOC_NONCE = '3156853299f313e23d1673dc12e1703d';
const DOC_ACTION = 'RunInstances';
const DOC_VERSION = '2014-05-26';
const DOC_HOST = 'ecs.cn-shanghai.aliyuncs.com';
const DOC_IMAGE = 'win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd';
const DOC_REGION = 'cn-shanghai';
// 文档给出的 HashedCanonicalRequest 与 Signature。
const DOC_HASHED_REQUEST = '7ea06492da5221eba5297e897ce16e55f964061054b7695beedaac1145b1e259';
const DOC_SIGNATURE = '06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0';
const DOC_SIGNED_HEADERS =
  'host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version';
const DOC_AUTHORIZATION = `ACS3-HMAC-SHA256 Credential=${DOC_ID},SignedHeaders=${DOC_SIGNED_HEADERS},Signature=${DOC_SIGNATURE}`;

const DOC_ENDPOINTS: [string, string][] = [
  ['正序', `https://${DOC_HOST}/?ImageId=${DOC_IMAGE}&RegionId=${DOC_REGION}`],
  ['倒序', `https://${DOC_HOST}/?RegionId=${DOC_REGION}&ImageId=${DOC_IMAGE}`],
];

it.each(DOC_ENDPOINTS)(
  '[AC-B1-12w#1] platform 签名器对官方签名示例给出逐字相同的 Authorization（查询参数%s给出），只回请求头、不改请求',
  async (_order, endpoint) => {
    const request: AliyunSignRequest = Object.freeze({
      endpoint,
      method: 'POST',
      headers: {},
      body: '',
      action: DOC_ACTION,
      version: DOC_VERSION,
    });
    const before = JSON.stringify(request);
    const sign = createAliyunAcs3Signer({
      clock: new FixedClock(DOC_DATE),
      nonce: () => DOC_NONCE,
    });
    const headers = lowerHeaders(await sign(request, DOC_PAIR, new AbortController().signal));
    expect(headers['authorization']).toBe(DOC_AUTHORIZATION);
    expect({
      host: headers['host'],
      action: headers['x-acs-action'],
      version: headers['x-acs-version'],
      date: headers['x-acs-date'],
      nonce: headers['x-acs-signature-nonce'],
      payload: headers['x-acs-content-sha256'],
    }).toEqual({
      host: DOC_HOST,
      action: DOC_ACTION,
      version: DOC_VERSION,
      date: DOC_DATE,
      nonce: DOC_NONCE,
      payload: sha256(''),
    });
    expect(JSON.stringify(request)).toBe(before);
    expect(JSON.stringify(headers)).not.toContain(DOC_PAIR.accessKeySecret);

    // 同一示例由独立 oracle 复算，得到文档的 HashedCanonicalRequest 与 Signature。
    const oracle = acs3Oracle({
      method: 'POST',
      host: DOC_HOST,
      path: '/',
      query: [
        ['RegionId', DOC_REGION],
        ['ImageId', DOC_IMAGE],
      ],
      headers: {
        'x-acs-action': DOC_ACTION,
        'x-acs-version': DOC_VERSION,
        'x-acs-date': DOC_DATE,
        'x-acs-signature-nonce': DOC_NONCE,
        'x-acs-content-sha256': sha256(''),
      },
      body: '',
      accessKeyId: DOC_PAIR.accessKeyId,
      hmacKey: DOC_PAIR.accessKeySecret,
    });
    expect(oracle.hashedRequest).toBe(DOC_HASHED_REQUEST);
    expect(oracle.authorization).toBe(DOC_AUTHORIZATION);
  },
);

it('[AC-B1-12w#2] agent 的 guard/review/sign.ts 再导出 platform 的签名器：同一函数，内容安全请求的签名头逐字相同', async () => {
  expect(agentSign.createAliyunAcs3Signer).toBe(createAliyunAcs3Signer);
  const deps = () => ({
    clock: new FixedClock('2026-10-24T03:04:05.678Z'),
    nonce: () => 'synthetic-fixed-nonce',
  });
  const pair = { accessKeyId: 'synthetic-review-id', accessKeySecret: 'synthetic-review-value' };
  const fromPlatform: unknown[] = [];
  const fromAgent: unknown[] = [];
  for (const body of [
    '',
    'Service=llm_query_moderation&ServiceParameters=%7B%22content%22%3A%22%E6%9D%AF%22%7D',
  ]) {
    const request: AgentSignRequest = {
      endpoint: 'https://review.example.invalid/',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body,
      action: 'TextModerationPlus',
      version: '2022-03-02',
    };
    const signal = new AbortController().signal;
    fromPlatform.push(await createAliyunAcs3Signer(deps())(request, pair, signal));
    fromAgent.push(await agentSign.createAliyunAcs3Signer(deps())(request, pair, signal));
  }
  expect(fromPlatform).toHaveLength(2);
  expect(fromAgent).toEqual(fromPlatform);
});

it('[AC-B1-12w#3] 查询参数按 RFC 3986 编码（中文、JSON、空格、保留字符）并按名字排序后签名，与独立 oracle 一致', async () => {
  const pairs: [string, string][] = [
    ['TemplateParam', '{"code":"042019","name":"A B"}'],
    ['SignName', '测试签名'],
    ['OutId', "id-!'()*~._"],
    ['PhoneNumbers', '13912345678'],
  ];
  const query = pairs
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
  const sign = createAliyunAcs3Signer({
    clock: new FixedClock('2026-10-24T01:02:03.456Z'),
    nonce: () => 'synthetic-query-nonce',
  });
  const pair = { accessKeyId: 'test-sms-id', accessKeySecret: 'test-sms-sentinel-value' };
  const headers = lowerHeaders(
    await sign(
      {
        endpoint: `https://dysmsapi.aliyuncs.com/?${query}`,
        method: 'POST',
        headers: {},
        body: '',
        action: 'SendSms',
        version: '2017-05-25',
      },
      pair,
      new AbortController().signal,
    ),
  );
  const oracle = acs3Oracle({
    method: 'POST',
    host: 'dysmsapi.aliyuncs.com',
    path: '/',
    query: pairs,
    headers: {
      'x-acs-action': 'SendSms',
      'x-acs-version': '2017-05-25',
      'x-acs-date': '2026-10-24T01:02:03Z',
      'x-acs-signature-nonce': 'synthetic-query-nonce',
      'x-acs-content-sha256': sha256(''),
    },
    body: '',
    accessKeyId: pair.accessKeyId,
    hmacKey: pair.accessKeySecret,
  });
  expect(headers['authorization']).toBe(oracle.authorization);
  expect(headers['x-acs-date']).toBe('2026-10-24T01:02:03Z');
});
