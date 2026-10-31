import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../platform/index.ts';
import { UnionError, type UnionEndpoint } from '../../domain/types.ts';
import type { UnionTransport } from '../replay.ts';
import { JdUnionAdapter, type JdBusinessParameters, type JdCredentials } from './jd-adapter.ts';
import { signJdParameters } from './sign.ts';

// 合成值，不是录制或真实凭据。
const method = 'jd.union.open.synthetic.get';
const keys = { envelope: 'jd_union_open_synthetic_get_responce', resultKey: 'queryResult' };
const endpoint: UnionEndpoint = {
  platform: 'jd',
  mode: 'live',
  baseUrl: 'https://jd-gateway.invalid/routerjson',
  quotaKey: 'jd-example',
};

function setup() {
  const credentials = vi.fn<() => Promise<JdCredentials>>(async () => ({
    appKey: 'test-jd-app-key',
    appSecret: 'plain-plain-plain-plain',
  }));
  const transport = vi.fn<UnionTransport>();
  const adapter = new JdUnionAdapter({
    clock: new FixedClock('2026-10-30T15:55:42.000Z'),
    credentials,
    transport,
    endpoint,
  });
  return { adapter, credentials, transport };
}

const circular: Record<string, unknown> = {};
circular.self = circular;

it.each<[string, JdBusinessParameters]>([
  ['顶层 NaN', { pageSize: Number.NaN }],
  ['嵌套 Infinity', { req: { list: [Number.POSITIVE_INFINITY] } }],
  ['BigInt', { orderId: 1n }],
  ['循环引用', circular],
])('[AC-B1-04za-UNIT#20] 业务参数含%s → invalid_dto，不取凭据、不发请求', async (_label, bad) => {
  const { adapter, credentials, transport } = setup();
  await expect(adapter.request(method, bad, keys)).rejects.toMatchObject({
    code: 'invalid_dto',
    platform: 'jd',
  });
  await expect(adapter.request(method, bad, keys)).rejects.toBeInstanceOf(UnionError);
  expect(credentials).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});

it('[AC-B1-04za-UNIT#21] 签名的参数名按 UTF-8 字节序，不是 UTF-16 码元序', () => {
  // U+FFFD 的 UTF-8 首字节 EF 小于 U+10000 的 F0，而 UTF-16 码元序相反。
  const expected = createHash('md5')
    .update('s\u{fffd}1\u{10000}2s', 'utf8')
    .digest('hex')
    .toUpperCase();
  expect(signJdParameters({ '\u{10000}': '2', '\u{fffd}': '1' }, 's')).toBe(expected);
});
