// B2-15k 支付宝证书模式（claude-independent，SPEC_REF deb521c2）：任务书 9.8（证书三件）、9.2（证书 SN 不符一律 unknown）；
// r3 第 1 轮第 7、9 项与建议改 ①（issuer 属性开头的 U+FEFF 不能被解码删除）。SN 算法来自官方 SDK（r3 所引），文档
// docs-mirror/alipay/guides/browser-02mse7.md:54-57 只写了 alipay_cert_sn 的用途；未实测（BR-PAY-09）。
// 证书在运行时现拼，见 kit.ts selfSignedCert。
import { createPublicKey } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AlipayLaunch } from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
import {
  AlipayPayChannel,
  UnavailablePayChannel,
} from '../../../../apps/api/src/modules/payment/infra/channels/index.ts';
import {
  certSn,
  publicKeyFromCert,
  rootCertSn,
} from '../../../../apps/api/src/modules/payment/infra/channels/alipay/cert-sn.ts';
import {
  ALIPAY_APP,
  ALIPAY_ORDER,
  ALIPAY_PLATFORM,
  OTHER,
  OUT,
  QUERY_NODE,
  aliAnswer,
  aliBody,
  aliNotification,
  aliParams,
  aliPayFields,
  aliSign,
  aliTrade,
  channelSetOf,
  expectUnknown,
  expectedSn,
  loadFor,
  okOf,
  rawAnswer,
  selfSignedCert,
  stagingEnv,
  withKeyDir,
  type CertAttribute,
  type Route,
} from './kit.ts';

const ROOT_ATTRIBUTES: readonly CertAttribute[] = [
  { name: 'C', value: 'CN' },
  { name: 'O', value: 'Test Root' },
  { name: 'CN', value: 'test-root' },
];
const APP_ATTRIBUTES: readonly CertAttribute[] = [
  { name: 'C', value: 'CN' },
  { name: 'CN', value: 'test-app' },
];
const ALIPAY_ATTRIBUTES: readonly CertAttribute[] = [
  { name: 'C', value: 'CN' },
  { name: 'CN', value: 'test-alipay' },
];

const APP_SERIAL = 11n;
const ALIPAY_SERIAL = 2n ** 70n + 5n;
const ROOT_SERIALS = [21n, 22n] as const;

const APP_SN = expectedSn(APP_ATTRIBUTES, APP_SERIAL);
const ALIPAY_SN = expectedSn(ALIPAY_ATTRIBUTES, ALIPAY_SERIAL);
const ROOT_SN = ROOT_SERIALS.map((serial) => expectedSn(ROOT_ATTRIBUTES, serial)).join('_');

const ROOT_BUNDLE = ROOT_SERIALS.map((serial) =>
  selfSignedCert(ROOT_ATTRIBUTES, serial, OTHER),
).join('');

/** 公钥模式的文件换成证书三件。 */
async function certEnv(dir: string): Promise<Record<string, string>> {
  await Promise.all([
    writeFile(join(dir, 'app.crt'), selfSignedCert(APP_ATTRIBUTES, APP_SERIAL, ALIPAY_APP)),
    writeFile(
      join(dir, 'alipay.crt'),
      selfSignedCert(ALIPAY_ATTRIBUTES, ALIPAY_SERIAL, ALIPAY_PLATFORM),
    ),
    writeFile(join(dir, 'root.crt'), ROOT_BUNDLE),
  ]);
  const env = stagingEnv(dir);
  delete env['PAY_ALIPAY_PUBLIC_KEY_FILE'];
  return {
    ...env,
    PAY_ALIPAY_APP_CERT_FILE: join(dir, 'app.crt'),
    PAY_ALIPAY_PUBLIC_CERT_FILE: join(dir, 'alipay.crt'),
    PAY_ALIPAY_ROOT_CERT_FILE: join(dir, 'root.crt'),
  };
}

async function inCertMode(
  route: Route,
  run: (
    channel: AlipayPayChannel,
    calls: Awaited<ReturnType<typeof channelSetOf>>['calls'],
  ) => Promise<void>,
): Promise<void> {
  await withKeyDir(async (dir) => {
    const { set, calls } = await channelSetOf(loadFor(await certEnv(dir), 'api'), route);
    const channel = set.of('alipay');
    expect(channel).toBeInstanceOf(AlipayPayChannel);
    await run(channel as AlipayPayChannel, calls);
  });
}

it('[AC-B2-15k#1101] r3 建议改 ①：issuer 属性开头的 U+FEFF 按原值算 SN，不被解码删除', () => {
  const attributes: readonly CertAttribute[] = [
    { name: 'CN', value: `${String.fromCodePoint(0xfeff)}Test` },
  ];
  const pem = selfSignedCert(attributes, 7n, OTHER);
  expect(certSn(pem)).toBe(expectedSn(attributes, 7n));
  expect(certSn(pem)).not.toBe(expectedSn([{ name: 'CN', value: 'Test' }], 7n));
});

it('[AC-B2-15k#1102] 属性按证书顺序逆序、值不转义（逗号也原样），序列号十进制', () => {
  const attributes: readonly CertAttribute[] = [
    { name: 'C', value: 'CN' },
    { name: 'O', value: 'Example, Inc.' },
    { name: 'CN', value: 'test-special' },
  ];
  expect(certSn(selfSignedCert(attributes, 2n ** 70n + 5n, OTHER))).toBe(
    expectedSn(attributes, 2n ** 70n + 5n),
  );
});

it('[AC-B2-15k#1103] 根证书链：各证书 SN 用 _ 连接', () => {
  expect(rootCertSn(ROOT_BUNDLE)).toBe(ROOT_SN);
});

it('[AC-B2-15k#1104] publicKeyFromCert：取出证书里的公钥', () => {
  const pem = selfSignedCert(APP_ATTRIBUTES, APP_SERIAL, ALIPAY_PLATFORM);
  const key = publicKeyFromCert(pem);
  expect(createPublicKey(key).export({ type: 'spki', format: 'der' })).toEqual(
    createPublicKey(ALIPAY_PLATFORM.publicKey).export({ type: 'spki', format: 'der' }),
  );
});

it('[AC-B2-15k#1105] 证书模式：orderStr 与接口请求带 app_cert_sn、alipay_root_cert_sn，且都参与签名', async () => {
  await inCertMode(
    () => aliAnswer(QUERY_NODE, aliTrade(), { certSn: ALIPAY_SN }),
    async (channel, calls) => {
      const launch = okOf(await channel.createOrder(ALIPAY_ORDER)).launch as AlipayLaunch;
      const order = new URLSearchParams(launch.order_str);
      expect(order.get('app_cert_sn')).toBe(APP_SN);
      expect(order.get('alipay_root_cert_sn')).toBe(ROOT_SN);
      okOf(await channel.query(OUT));
      const params = aliParams(calls[0]!);
      expect(params.get('app_cert_sn')).toBe(APP_SN);
      expect(params.get('alipay_root_cert_sn')).toBe(ROOT_SN);
    },
  );
});

it('[AC-B2-15k#1106] 证书模式：alipay_cert_sn 等于配置的证书 SN 且签名对才 ok；验签用证书里的公钥', async () => {
  await inCertMode(
    () => aliAnswer(QUERY_NODE, aliTrade(), { certSn: ALIPAY_SN }),
    async (channel) => {
      expect(okOf(await channel.query(OUT)).channelState).toBe('TRADE_SUCCESS');
    },
  );
});

const RAW = JSON.stringify(aliTrade());
const SIGN = JSON.stringify(aliSign(RAW));

it.each([
  ['alipay_cert_sn 缺失', rawAnswer(`{"${QUERY_NODE}":${RAW},"sign":${SIGN}}`)],
  ['alipay_cert_sn 不符', aliAnswer(QUERY_NODE, RAW, { certSn: 'other-sn' })],
  [
    'alipay_cert_sn 不是字符串',
    rawAnswer(`{"${QUERY_NODE}":${RAW},"alipay_cert_sn":42,"sign":${SIGN}}`),
  ],
  [
    'alipay_cert_sn 重复',
    rawAnswer(
      `{"${QUERY_NODE}":${RAW},"alipay_cert_sn":${JSON.stringify(ALIPAY_SN)},` +
        `"alipay_cert_sn":"other-sn","sign":${SIGN}}`,
    ),
  ],
  [
    'SN 对、别的私钥签的',
    rawAnswer(aliBody(QUERY_NODE, RAW, { certSn: ALIPAY_SN, key: OTHER.privateKey })),
  ],
])('[AC-B2-15k#1107] 证书模式应答不可信（%s）：unknown', async (_name, answer) => {
  await inCertMode(
    () => answer,
    async (channel) => {
      expectUnknown(await channel.query(OUT));
    },
  );
});

it('[AC-B2-15k#1108] 证书模式：通知用证书里的公钥验签', async () => {
  await inCertMode(
    () => rawAnswer('', 500),
    async (channel) => {
      okOf(await channel.verifyNotification(aliNotification(aliPayFields())));
      const other = aliNotification(aliPayFields(), { key: OTHER.privateKey });
      expect((await channel.verifyNotification(other)).kind).toBe('rejected');
    },
  );
});

it.each(['PAY_ALIPAY_APP_CERT_FILE', 'PAY_ALIPAY_PUBLIC_CERT_FILE', 'PAY_ALIPAY_ROOT_CERT_FILE'])(
  '[AC-B2-15k#1109] 证书三件缺 %s：支付宝不可用（fail-close），不抛异常',
  async (name) => {
    await withKeyDir(async (dir) => {
      const env = await certEnv(dir);
      delete env[name];
      const { set, logs } = await channelSetOf(loadFor(env, 'api'));
      expect(set.of('alipay')).toBeInstanceOf(UnavailablePayChannel);
      expect(logs.join('\n')).toContain(name);
    });
  },
);

it('[AC-B2-15k#1110] 证书文件内容不是证书：支付宝不可用，日志不带路径和内容', async () => {
  await withKeyDir(async (dir) => {
    const env = await certEnv(dir);
    await writeFile(join(dir, 'alipay.crt'), 'not a certificate');
    const { set, logs } = await channelSetOf(loadFor(env, 'api'));
    expect(set.of('alipay')).toBeInstanceOf(UnavailablePayChannel);
    const text = logs.join('\n');
    expect(text).not.toContain(dir);
    expect(text).not.toContain('not a certificate');
  });
});
