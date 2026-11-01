// B2-15k 规则测试公用件（claude-independent，SPEC_REF deb521c2；BR-PAY-03/04/05/06/08/09，任务书第 9 节）。
// 不连库、不联网。密钥在运行时用 node:crypto 现生成；其他假值用低熵串。
// 这里只有测试侧的签名与应答构造，不含任何适配器实现；渠道事实的出处写在各测试文件头。
import {
  createCipheriv,
  createHash,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
} from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import type {
  PayCreateOrderInput,
  PayRawNotification,
} from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
import { AlipayPayChannel } from '../../../../apps/api/src/modules/payment/infra/channels/alipay/alipay-pay-channel.ts';
import type { AlipayCertSerials } from '../../../../apps/api/src/modules/payment/infra/channels/alipay/alipay-pay-channel.ts';
import { createPayChannelSet } from '../../../../apps/api/src/modules/payment/infra/channels/index.ts';
import type {
  PayHttpRequest,
  PayHttpResponse,
  PayTransport,
} from '../../../../apps/api/src/modules/payment/infra/channels/transport.ts';
import { WechatPayChannel } from '../../../../apps/api/src/modules/payment/infra/channels/wechat/wechat-pay-channel.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/clock.ts';
import {
  loadConfig,
  type AppConfig,
} from '../../../../apps/api/src/modules/platform/config/config.ts';
import type { EntryName } from '../../../../apps/api/src/modules/platform/entries.ts';
import {
  createRootLogger,
  type RootLogger,
} from '../../../../apps/api/src/modules/platform/logging/logger.ts';

export type Json = Record<string, unknown>;
export type Route = (request: PayHttpRequest) => PayHttpResponse | Promise<PayHttpResponse>;

interface Pair {
  readonly privateKey: string;
  readonly publicKey: string;
}

function rsa(): Pair {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
}

/** 微信商户 API 证书私钥。 */
export const MERCHANT = rsa();
/** 微信支付公钥那一对（私钥只在测试里用来冒充渠道签应答）。 */
export const WECHAT_PLATFORM = rsa();
/** 支付宝应用私钥。 */
export const ALIPAY_APP = rsa();
/** 支付宝公钥那一对（私钥只在测试里用来冒充渠道签应答）。 */
export const ALIPAY_PLATFORM = rsa();
/** 与我方无关的第三方密钥。 */
export const OTHER = rsa();

export const NOW = new Date('2026-11-01T04:00:00.000Z');
export const NOW_S = Math.floor(NOW.getTime() / 1000);

export const PAY_APP_ID = 'couli-app-test';
export const MCHID = '1900000109';
export const WX_APPID = 'wx-test-appid';
export const MERCHANT_SERIAL = 'SERIAL-TEST';
export const PUBLIC_KEY_ID = 'PUB_KEY_ID_TEST';
export const APIV3_KEY = 'k'.repeat(32);
export const NOTIFY_BASE = 'https://pay.example.test';
export const ALIPAY_APPID = '2021000000000001';
export const SELLER_ID = '2088000000000001';
export const SANDBOX_GATEWAY = 'https://gateway.example.test/gateway.do';
export const OFFICIAL_GATEWAY = 'https://openapi.alipay.com/gateway.do';
export const WECHAT_API = 'https://api.mch.weixin.qq.com';

export const OUT = 'P20261101000001';
export const TRADE_NO = '42000000000000000001';
export const OUT_REFUND = 'R20261101000001';
export const REFUND_ID = '50000000000000000001';
/** 渠道侧用户标识：不得出现在结果或日志里（BR-PAY-08 ④）。 */
export const OPENID = 'oSyntheticPrivateOpenid123';
export const BUYER_LOGON = '159****5620';

export const ORDER: PayCreateOrderInput = {
  outTradeNo: OUT,
  amountFen: 100n,
  description: '凑狸会员',
  expireAt: new Date('2026-11-01T04:15:00.900Z'),
  notifyUrl: '/notify/pay/wechat',
};

export const ALIPAY_ORDER: PayCreateOrderInput = { ...ORDER, notifyUrl: '/notify/pay/alipay' };

export const REFUND = {
  outTradeNo: OUT,
  channelTradeNo: null,
  outRefundNo: OUT_REFUND,
  refundFen: 10n,
  totalFen: 100n,
  reason: 'USER_REQUEST',
} as const;

export const ORIGINAL = { outTradeNo: OUT, channelTradeNo: TRADE_NO } as const;

// ---- 传输与日志

export function captureLogger(logs: string[]): RootLogger {
  return createRootLogger(
    { entry: 'api', appEnv: 'test', level: 'trace' },
    {
      write: (line) => {
        logs.push(line);
      },
    },
  );
}

export function transportOf(route: Route): {
  readonly calls: PayHttpRequest[];
  readonly transport: PayTransport;
} {
  const calls: PayHttpRequest[] = [];
  const transport: PayTransport = async (request) => {
    calls.push(request);
    return route(request);
  };
  return { calls, transport };
}

export const NO_NETWORK: Route = () => {
  throw new Error('unexpected channel call');
};

export function headerOf(request: PayHttpRequest, name: string): string {
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return '';
}

/** 含 bigint 的结果转文本，用来断言结果里没有渠道侧用户标识。 */
export function textOf(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}

/** 结果只有 ok 或 unknown；reason 只能是固定常量（任务书 9.2、9.10）。 */
export function expectUnknown(result: { readonly kind: string; readonly reason?: string }): void {
  expect(result.kind).toBe('unknown');
  expect(result.reason).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
}

export function expectRejected(result: { readonly kind: string; readonly reason?: string }): void {
  expect(result.kind).toBe('rejected');
  expect(result.reason).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
}

export function okOf<T extends { readonly kind: string }>(result: T): Extract<T, { kind: 'ok' }> {
  expect(result.kind).toBe('ok');
  return result as unknown as Extract<T, { kind: 'ok' }>;
}

export function without(object: Json, ...keys: readonly string[]): Json {
  const copy: Json = { ...object };
  for (const key of keys) delete copy[key];
  return copy;
}

// ---- 微信：应答与通知（docs-mirror/wechat-pay/pages/4013053249.txt：验签串三行，行尾都有 \n）

export type WxHeader =
  'wechatpay-timestamp' | 'wechatpay-nonce' | 'wechatpay-signature' | 'wechatpay-serial';

export interface WxSignOptions {
  /** 应答时间（Unix 秒），默认 NOW_S。 */
  readonly at?: number;
  /** 直接指定时间戳头的文本（覆盖 at）。 */
  readonly timestamp?: string;
  readonly serial?: string;
  /** 直接指定签名头（不计算）。 */
  readonly signature?: string;
  readonly key?: string;
}

export function wxSignature(timestamp: string, nonce: string, body: string, key: string): string {
  return createSign('RSA-SHA256')
    .update(`${timestamp}\n${nonce}\n${body}\n`, 'utf8')
    .sign(key, 'base64');
}

export function wxHeaders(body: string, options: WxSignOptions = {}): Record<string, string> {
  const timestamp = options.timestamp ?? String(options.at ?? NOW_S);
  const nonce = 'resp-nonce';
  return {
    'wechatpay-timestamp': timestamp,
    'wechatpay-nonce': nonce,
    'wechatpay-signature':
      options.signature ??
      wxSignature(timestamp, nonce, body, options.key ?? WECHAT_PLATFORM.privateKey),
    'wechatpay-serial': options.serial ?? PUBLIC_KEY_ID,
    'wechatpay-signature-type': 'WECHATPAY2-SHA256-RSA2048',
  };
}

export function wxAnswer(
  status: number,
  body: string | Json,
  options: WxSignOptions = {},
): PayHttpResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, headers: wxHeaders(text, options), body: text };
}

/** 文档示例形状的商户单号查询应答（4013070356.txt:450-611）。 */
export function wxTrade(overrides: Json = {}): Json {
  return {
    appid: WX_APPID,
    mchid: MCHID,
    out_trade_no: OUT,
    transaction_id: TRADE_NO,
    trade_type: 'APP',
    trade_state: 'SUCCESS',
    trade_state_desc: 'desc',
    bank_type: 'OTHERS',
    success_time: '2026-11-01T12:00:00+08:00',
    payer: { openid: OPENID },
    amount: { total: 100, payer_total: 100, currency: 'CNY', payer_currency: 'CNY' },
    ...overrides,
  };
}

/** 文档示例形状的退款应答（4013070371.txt:759-910、4013070374.txt:558-735，都没有 appid / mchid）。 */
export function wxRefund(overrides: Json = {}): Json {
  return {
    refund_id: REFUND_ID,
    out_refund_no: OUT_REFUND,
    transaction_id: TRADE_NO,
    out_trade_no: OUT,
    channel: 'ORIGINAL',
    user_received_account: 'account',
    create_time: '2026-11-01T12:00:00+08:00',
    status: 'PROCESSING',
    funds_account: 'UNSETTLED',
    amount: {
      total: 100,
      refund: 10,
      payer_total: 100,
      payer_refund: 10,
      settlement_refund: 10,
      settlement_total: 100,
      discount_refund: 0,
      currency: 'CNY',
    },
    ...overrides,
  };
}

/**
 * 同一份成功正文的各种不可信信封：验签不过、缺签名、序列号不符、超时间窗、HTTP 非预期、JSON 非法。
 * 任务书 9.2：全部 unknown。
 */
export function wxEnvelopeFaults(body: string): [string, PayHttpResponse][] {
  const signed = wxAnswer(200, body);
  const drop = (name: WxHeader): PayHttpResponse => {
    const headers: Record<string, string> = { ...signed.headers };
    delete headers[name];
    return { ...signed, headers };
  };
  const fake = Buffer.from('not-a-signature').toString('base64');
  return [
    ['缺 Wechatpay-Timestamp', drop('wechatpay-timestamp')],
    ['缺 Wechatpay-Nonce', drop('wechatpay-nonce')],
    ['缺 Wechatpay-Signature', drop('wechatpay-signature')],
    ['缺 Wechatpay-Serial', drop('wechatpay-serial')],
    ['签名不对', wxAnswer(200, body, { signature: fake })],
    [
      '探测签名 WECHATPAY/SIGNTEST/',
      wxAnswer(200, body, { signature: `WECHATPAY/SIGNTEST/${fake}` }),
    ],
    ['别的私钥签的', wxAnswer(200, body, { key: OTHER.privateKey })],
    ['序列号不是配置的公钥 ID', wxAnswer(200, body, { serial: 'PUB_KEY_ID_OTHER' })],
    ['时间戳早 300 秒', wxAnswer(200, body, { at: NOW_S - 300 })],
    ['时间戳晚 300 秒', wxAnswer(200, body, { at: NOW_S + 300 })],
    ['时间戳早 301 秒', wxAnswer(200, body, { at: NOW_S - 301 })],
    ['时间戳晚 301 秒', wxAnswer(200, body, { at: NOW_S + 301 })],
    ['时间戳不是数字', wxAnswer(200, body, { timestamp: 'soon' })],
    ['正文被改过', { ...signed, body: `${body} ` }],
    ['HTTP 201', wxAnswer(201, body)],
    ['HTTP 302', wxAnswer(302, body)],
    ['HTTP 429', wxAnswer(429, body)],
    ['HTTP 500', wxAnswer(500, body)],
    ['HTTP 204 空正文', wxAnswer(204, '')],
    ['非法 JSON', wxAnswer(200, '{not json')],
    ['JSON 数组', wxAnswer(200, '[]')],
    ['JSON null', wxAnswer(200, 'null')],
    ['JSON 字符串', wxAnswer(200, '"text"')],
  ];
}

export function wechatChannel(route: Route = NO_NETWORK): {
  readonly channel: WechatPayChannel;
  readonly calls: PayHttpRequest[];
  readonly logs: string[];
} {
  const { calls, transport } = transportOf(route);
  const logs: string[] = [];
  const channel = new WechatPayChannel({
    config: {
      payAppId: PAY_APP_ID,
      appId: WX_APPID,
      mchId: MCHID,
      merchantSerial: MERCHANT_SERIAL,
      publicKeyId: PUBLIC_KEY_ID,
      notifyBaseUrl: NOTIFY_BASE,
    },
    keys: {
      privateKeyPem: MERCHANT.privateKey,
      apiV3Key: APIV3_KEY,
      publicKeyPem: WECHAT_PLATFORM.publicKey,
    },
    transport,
    clock: new FixedClock(NOW),
    logger: captureLogger(logs),
  });
  return { channel, calls, logs };
}

/** 请求签名（4012365342.txt）：签名串五行 method、path+query、时间戳、随机串、正文，行尾都有 \n。 */
export function expectWxSigned(request: PayHttpRequest): void {
  const authorization = headerOf(request, 'authorization');
  expect(authorization.startsWith('WECHATPAY2-SHA256-RSA2048 ')).toBe(true);
  const field = (name: string): string =>
    new RegExp(`${name}="([^"]*)"`).exec(authorization)?.[1] ?? '';
  expect(field('mchid')).toBe(MCHID);
  expect(field('serial_no')).toBe(MERCHANT_SERIAL);
  expect(field('timestamp')).toBe(String(NOW_S));
  expect(field('nonce_str')).not.toBe('');
  const url = new URL(request.url);
  const message =
    `${request.method}\n${url.pathname}${url.search}\n${field('timestamp')}\n` +
    `${field('nonce_str')}\n${request.body ?? ''}\n`;
  expect(
    createVerify('RSA-SHA256')
      .update(message, 'utf8')
      .verify(MERCHANT.publicKey, field('signature'), 'base64'),
  ).toBe(true);
  // 请微信支付用这把公钥签应答：文档示例在每个请求都带 Wechatpay-Serial。
  expect(headerOf(request, 'wechatpay-serial')).toBe(PUBLIC_KEY_ID);
}

export interface WxResourceOptions {
  readonly key?: string;
  readonly nonce?: string;
  readonly aad?: string;
  readonly algorithm?: string;
  readonly originalType?: string;
}

/** AEAD_AES_256_GCM（4012071382.txt）：密文 = base64(密文 + 16 字节 tag)。 */
export function wxResource(plain: string, options: WxResourceOptions = {}): Json {
  const nonce = options.nonce ?? 'abcdefghijkl';
  const aad = options.aad ?? 'transaction';
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(options.key ?? APIV3_KEY, 'utf8'),
    Buffer.from(nonce, 'utf8'),
  );
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const sealed = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return {
    original_type: options.originalType ?? 'transaction',
    algorithm: options.algorithm ?? 'AEAD_AES_256_GCM',
    ciphertext: sealed.toString('base64'),
    associated_data: aad,
    nonce,
  };
}

export function wxNotification(
  resource: Json,
  overrides: Json = {},
  sign: WxSignOptions = {},
): PayRawNotification {
  const body = JSON.stringify({
    id: 'EV-2026110100000001',
    create_time: '2026-11-01T12:00:00+08:00',
    resource_type: 'encrypt-resource',
    event_type: 'TRANSACTION.SUCCESS',
    summary: 'summary',
    resource,
    ...overrides,
  });
  return { headers: wxHeaders(body, sign), body };
}

export function wxPayNotification(trade: Json = wxTrade()): PayRawNotification {
  return wxNotification(wxResource(JSON.stringify(trade)));
}

/** 文档示例形状的退款通知明文（4013070388.txt:246-310：有 mchid，没有 appid）。 */
export function wxRefundPlain(overrides: Json = {}): Json {
  return {
    mchid: MCHID,
    transaction_id: TRADE_NO,
    out_trade_no: OUT,
    refund_id: REFUND_ID,
    out_refund_no: OUT_REFUND,
    refund_status: 'SUCCESS',
    success_time: '2026-11-01T12:00:00+08:00',
    user_received_account: 'account',
    amount: { total: 100, refund: 10, payer_total: 100, payer_refund: 10 },
    ...overrides,
  };
}

export function wxRefundNotification(plain: Json = wxRefundPlain()): PayRawNotification {
  return wxNotification(
    wxResource(JSON.stringify(plain), { aad: 'refund', originalType: 'refund' }),
    { event_type: 'REFUND.SUCCESS' },
  );
}

// ---- 支付宝：应答与通知（docs-mirror/alipay/guides/browser-02mse7.md：只对 xxx_response 的原文验签）

export const QUERY_NODE = 'alipay_trade_query_response';
export const CLOSE_NODE = 'alipay_trade_close_response';
export const REFUND_NODE = 'alipay_trade_refund_response';
export const REFUND_QUERY_NODE = 'alipay_trade_fastpay_refund_query_response';
export const BILL_NODE = 'alipay_data_dataservice_bill_downloadurl_query_response';

export function aliSign(content: string, key: string = ALIPAY_PLATFORM.privateKey): string {
  return createSign('RSA-SHA256').update(content, 'utf8').sign(key, 'base64');
}

export interface AliAnswerOptions {
  readonly key?: string;
  /** 证书模式的 alipay_cert_sn；默认不带。 */
  readonly certSn?: string;
}

function nodeText(node: string | Json): string {
  return typeof node === 'string' ? node : JSON.stringify(node);
}

export function aliBody(
  nodeKey: string,
  node: string | Json,
  options: AliAnswerOptions = {},
): string {
  const raw = nodeText(node);
  const sn =
    options.certSn === undefined ? '' : `,"alipay_cert_sn":${JSON.stringify(options.certSn)}`;
  return `{"${nodeKey}":${raw}${sn},"sign":${JSON.stringify(aliSign(raw, options.key))}}`;
}

export function aliAnswer(
  nodeKey: string,
  node: string | Json,
  options: AliAnswerOptions = {},
): PayHttpResponse {
  return { status: 200, headers: {}, body: aliBody(nodeKey, node, options) };
}

export function rawAnswer(body: string, status = 200): PayHttpResponse {
  return { status, headers: {}, body };
}

/** 文档示例形状的 trade.query 应答（02e7gm.md:261-297，没有 seller_id / app_id）。 */
export function aliTrade(overrides: Json = {}): Json {
  return {
    code: '10000',
    msg: 'Success',
    trade_no: TRADE_NO,
    out_trade_no: OUT,
    buyer_logon_id: BUYER_LOGON,
    trade_status: 'TRADE_SUCCESS',
    total_amount: '1.00',
    buyer_open_id: OPENID,
    ...overrides,
  };
}

export function aliError(code: string, subCode: string, overrides: Json = {}): Json {
  return { code, msg: 'msg', sub_code: subCode, sub_msg: 'sub msg', ...overrides };
}

/** 文档示例形状的 trade.refund 应答（02e7go.md:440-503）。 */
export function aliRefundAnswer(overrides: Json = {}): Json {
  return {
    code: '10000',
    msg: 'Success',
    trade_no: TRADE_NO,
    out_trade_no: OUT,
    buyer_logon_id: BUYER_LOGON,
    fund_change: 'Y',
    refund_fee: '0.10',
    ...overrides,
  };
}

/** 文档示例形状的 fastpay.refund.query 应答（02e7gp.md:250-341）。 */
export function aliRefundQueryAnswer(overrides: Json = {}): Json {
  return {
    code: '10000',
    msg: 'Success',
    trade_no: TRADE_NO,
    out_trade_no: OUT,
    out_request_no: OUT_REFUND,
    total_amount: '1.00',
    refund_amount: '0.10',
    refund_status: 'REFUND_SUCCESS',
    ...overrides,
  };
}

/**
 * 同一份已签名节点的各种不可信外壳（r3 第 1、2 轮「外围 JSON」与必须改 ①）：嵌套冒充键、重复键、接口键被换、
 * Unicode 键别名、尾随内容、非法字面量、HTTP 非预期。任务书 9.2：全部 unknown。
 */
export function aliEnvelopeFaults(
  nodeKey: string,
  node: string | Json,
): [string, PayHttpResponse][] {
  const raw = nodeText(node);
  const forged = raw.replace(/^\{/, '{"forged":"1",');
  const sign = JSON.stringify(aliSign(raw));
  const fake = JSON.stringify(Buffer.from('not-a-signature').toString('base64'));
  const asString = JSON.stringify(raw);
  return [
    ['缺 sign', rawAnswer(`{"${nodeKey}":${raw}}`)],
    ['sign 是空串', rawAnswer(`{"${nodeKey}":${raw},"sign":""}`)],
    ['sign 不是字符串', rawAnswer(`{"${nodeKey}":${raw},"sign":123}`)],
    ['签名不对', rawAnswer(`{"${nodeKey}":${raw},"sign":${fake}}`)],
    ['别的私钥签的', aliAnswer(nodeKey, raw, { key: OTHER.privateKey })],
    [
      '嵌套冒充键：真节点藏在里层、外层是伪造的',
      rawAnswer(`{"wrap":{"${nodeKey}":${raw}},"${nodeKey}":${forged},"sign":${sign}}`),
    ],
    ['节点只在嵌套里', rawAnswer(`{"wrap":{"${nodeKey}":${raw}},"sign":${sign}}`)],
    ['sign 只在嵌套里', rawAnswer(`{"${nodeKey}":${raw},"wrap":{"sign":${sign}}}`)],
    [
      '重复节点键：伪造的在后',
      rawAnswer(`{"${nodeKey}":${raw},"${nodeKey}":${forged},"sign":${sign}}`),
    ],
    [
      '重复节点键：伪造的在前',
      rawAnswer(`{"${nodeKey}":${forged},"${nodeKey}":${raw},"sign":${sign}}`),
    ],
    ['重复 sign', rawAnswer(`{"${nodeKey}":${raw},"sign":${sign},"sign":${fake}}`)],
    [
      'Unicode 键别名重复 sign',
      rawAnswer(`{"${nodeKey}":${raw},"sign":${sign},"\\u0073ign":${fake}}`),
    ],
    [
      '接口键被换成别的接口',
      rawAnswer(`{"alipay_trade_precreate_response":${raw},"sign":${sign}}`),
    ],
    [
      '同时带 error_response',
      rawAnswer(`{"${nodeKey}":${raw},"error_response":{"code":"40002"},"sign":${sign}}`),
    ],
    ['尾随内容', rawAnswer(`{"${nodeKey}":${raw},"sign":${sign}}x`)],
    ['外层有非法字面量', rawAnswer(`{"${nodeKey}":${raw},"junk":truefalse,"sign":${sign}}`)],
    [
      '节点是字符串',
      rawAnswer(`{"${nodeKey}":${asString},"sign":${JSON.stringify(aliSign(asString))}}`),
    ],
    ['HTTP 302', rawAnswer(aliBody(nodeKey, raw), 302)],
    ['HTTP 500', rawAnswer(aliBody(nodeKey, raw), 500)],
    ['HTTP 204 空正文', rawAnswer('', 204)],
    ['非法 JSON', rawAnswer('{not json')],
    ['JSON 数组', rawAnswer('[]')],
    ['JSON null', rawAnswer('null')],
  ];
}

export function alipayChannel(
  route: Route = NO_NETWORK,
  certSerials: AlipayCertSerials | null = null,
): {
  readonly channel: AlipayPayChannel;
  readonly calls: PayHttpRequest[];
  readonly logs: string[];
} {
  const { calls, transport } = transportOf(route);
  const logs: string[] = [];
  const channel = new AlipayPayChannel({
    config: {
      payAppId: PAY_APP_ID,
      appId: ALIPAY_APPID,
      sellerId: SELLER_ID,
      gateway: SANDBOX_GATEWAY,
      notifyBaseUrl: NOTIFY_BASE,
      certSerials,
    },
    keys: {
      privateKeyPem: ALIPAY_APP.privateKey,
      alipayPublicKeyPem: ALIPAY_PLATFORM.publicKey,
    },
    transport,
    clock: new FixedClock(NOW),
    logger: captureLogger(logs),
  });
  return { channel, calls, logs };
}

/** 公共参数可以在 query、也可以在表单正文：合起来读（02e7gm.md 的 cURL 示例是 query + 表单）。 */
export function aliParams(request: PayHttpRequest): Map<string, string> {
  const params = new Map<string, string>();
  for (const [key, value] of new URL(request.url).searchParams) params.set(key, value);
  for (const [key, value] of new URLSearchParams(request.body ?? '')) params.set(key, value);
  return params;
}

export function aliBiz(request: PayHttpRequest): Json {
  return JSON.parse(aliParams(request).get('biz_content') ?? '{}') as Json;
}

export function aliMethod(request: PayHttpRequest): string {
  return aliParams(request).get('method') ?? '';
}

/** RSA2：除 sign 外的参数按键排序、k=v 用 & 连接，不做编码。 */
export function expectAliSigned(params: ReadonlyMap<string, string>): void {
  const content = [...params.keys()]
    .filter((key) => key !== 'sign')
    .sort()
    .map((key) => `${key}=${params.get(key) ?? ''}`)
    .join('&');
  expect(params.get('sign_type')).toBe('RSA2');
  expect(
    createVerify('RSA-SHA256')
      .update(content, 'utf8')
      .verify(ALIPAY_APP.publicKey, params.get('sign') ?? '', 'base64'),
  ).toBe(true);
}

/** 文档示例形状的支付成功通知字段（00dn78.md:21-53）。 */
export function aliPayFields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    notify_time: '2026-11-01 12:00:03',
    notify_type: 'trade_status_sync',
    notify_id: 'ac05099524730693a8b330c5ecf72da9786',
    trade_no: TRADE_NO,
    app_id: ALIPAY_APPID,
    auth_app_id: ALIPAY_APPID,
    out_trade_no: OUT,
    buyer_logon_id: BUYER_LOGON,
    seller_id: SELLER_ID,
    trade_status: 'TRADE_SUCCESS',
    total_amount: '1.00',
    receipt_amount: '1.00',
    subject: '凑狸会员',
    gmt_payment: '2026-11-01 12:00:00',
    ...overrides,
  };
}

export function aliRefundFields(overrides: Record<string, string> = {}): Record<string, string> {
  return aliPayFields({
    out_biz_no: OUT_REFUND,
    refund_fee: '0.10',
    gmt_refund: '2026-11-01 12:00:01.320',
    ...overrides,
  });
}

/** 00dn78.md:110：除去 sign、sign_type，解码后按字典序拼接；再 RSA-SHA256。 */
export function aliSignContent(fields: Readonly<Record<string, string>>): string {
  return Object.keys(fields)
    .filter((key) => key !== 'sign' && key !== 'sign_type')
    .sort()
    .map((key) => `${key}=${fields[key] ?? ''}`)
    .join('&');
}

export function aliNotification(
  fields: Readonly<Record<string, string>>,
  options: { readonly key?: string; readonly signType?: string; readonly hash?: string } = {},
): PayRawNotification {
  const sign = createSign(options.hash ?? 'RSA-SHA256')
    .update(aliSignContent(fields), 'utf8')
    .sign(options.key ?? ALIPAY_PLATFORM.privateKey, 'base64');
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...fields,
      sign_type: options.signType ?? 'RSA2',
      sign,
    }).toString(),
  };
}

// ---- 证书（node:crypto 不能签发证书：测试里自己拼一张自签 DER，公开的格式，值全是假的）

function der(tag: number, ...parts: readonly Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  if (body.length < 0x80) return Buffer.concat([Buffer.from([tag, body.length]), body]);
  const length: number[] = [];
  for (let rest = body.length; rest > 0; rest = Math.floor(rest / 256)) length.unshift(rest % 256);
  return Buffer.concat([Buffer.from([tag, 0x80 | length.length, ...length]), body]);
}

const ATTRIBUTE_OIDS: Readonly<Record<string, readonly number[]>> = {
  CN: [0x55, 0x04, 0x03],
  C: [0x55, 0x04, 0x06],
  O: [0x55, 0x04, 0x0a],
};

export interface CertAttribute {
  readonly name: 'CN' | 'C' | 'O';
  readonly value: string;
}

function serialBytes(serial: bigint): Buffer {
  let hex = serial.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const bytes = Buffer.from(hex, 'hex');
  return (bytes[0] ?? 0) >= 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
}

/** 一张自签 v3 证书：issuer 与 subject 相同，属性值按 UTF8String 原样写入。 */
export function selfSignedCert(
  attributes: readonly CertAttribute[],
  serial: bigint,
  pair: Pair,
): string {
  const name = der(
    0x30,
    ...attributes.map((attribute) =>
      der(
        0x31,
        der(
          0x30,
          der(0x06, Buffer.from(ATTRIBUTE_OIDS[attribute.name] ?? [])),
          der(0x0c, Buffer.from(attribute.value, 'utf8')),
        ),
      ),
    ),
  );
  const algorithm = der(
    0x30,
    der(0x06, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b])),
    der(0x05),
  );
  const validity = der(
    0x30,
    der(0x17, Buffer.from('260101000000Z', 'latin1')),
    der(0x17, Buffer.from('360101000000Z', 'latin1')),
  );
  const spki = createPublicKey(pair.publicKey).export({ type: 'spki', format: 'der' });
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([0x02]))),
    der(0x02, serialBytes(serial)),
    algorithm,
    name,
    validity,
    name,
    spki,
  );
  const signature = createSign('RSA-SHA256').update(tbs).sign(pair.privateKey);
  const cert = der(0x30, tbs, algorithm, der(0x03, Buffer.from([0]), signature));
  const body = cert
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trimEnd();
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

/** 官方 SDK 的 SN 算法（r3 建议改 ① 所引）：属性逆序 name=原值、逗号连接，再接十进制序列号，取 md5。 */
export function expectedSn(attributes: readonly CertAttribute[], serial: bigint): string {
  const issuer = [...attributes]
    .reverse()
    .map((attribute) => `${attribute.name}=${attribute.value}`)
    .join(',');
  return createHash('md5')
    .update(`${issuer}${serial.toString(10)}`, 'utf8')
    .digest('hex');
}

// ---- 配置与工厂

/** loadConfig 的第二个参数（任务书 9.8 ②）：骨架阶段不动 loadConfig 本身，这里按契约调用。 */
export const loadFor = loadConfig as (
  env: Readonly<Record<string, string | undefined>>,
  entry: EntryName,
) => AppConfig;

export function baseEnv(appEnv: 'local' | 'test' | 'staging' | 'prod'): Record<string, string> {
  if (appEnv === 'local' || appEnv === 'test') return { APP_ENV: appEnv };
  return {
    APP_ENV: appEnv,
    FIELD_KEY_PROVIDER: 'kms',
    FIELD_KEYRING_FILE: '/nonexistent/unused-keyring.json',
    PRIOR_IDENTITY_KEY_PROVIDER: 'kms',
    PRIOR_IDENTITY_KEYRING_FILE: '/nonexistent/unused-prior-identity-keyring.json',
    ...(appEnv === 'prod' ? { AGENT_USER_HASH_KEY: 'test-only-agent-user-hash-key-b2-15k' } : {}),
  };
}

/** 把密钥写进临时目录再运行；结束后清理（失败也清理）。 */
export async function withKeyDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'couli-b2-15k-'));
  try {
    await Promise.all([
      writeFile(join(dir, 'wechat-private.pem'), MERCHANT.privateKey),
      writeFile(join(dir, 'wechat-apiv3.key'), APIV3_KEY),
      writeFile(join(dir, 'wechat-public.pem'), WECHAT_PLATFORM.publicKey),
      writeFile(join(dir, 'alipay-private.pem'), ALIPAY_APP.privateKey),
      writeFile(join(dir, 'alipay-public.pem'), ALIPAY_PLATFORM.publicKey),
    ]);
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function commonEnv(): Record<string, string> {
  return { PAY_APP_ID, PAY_NOTIFY_BASE_URL: NOTIFY_BASE };
}

export function wechatEnv(dir: string): Record<string, string> {
  return {
    PAY_WECHAT_APPID: WX_APPID,
    PAY_WECHAT_MCHID: MCHID,
    PAY_WECHAT_MERCHANT_SERIAL: MERCHANT_SERIAL,
    PAY_WECHAT_PRIVATE_KEY_FILE: join(dir, 'wechat-private.pem'),
    PAY_WECHAT_APIV3_KEY_FILE: join(dir, 'wechat-apiv3.key'),
    PAY_WECHAT_PUBLIC_KEY_FILE: join(dir, 'wechat-public.pem'),
    PAY_WECHAT_PUBLIC_KEY_ID: PUBLIC_KEY_ID,
  };
}

export function alipayEnv(dir: string): Record<string, string> {
  return {
    PAY_ALIPAY_APPID: ALIPAY_APPID,
    PAY_ALIPAY_SELLER_ID: SELLER_ID,
    PAY_ALIPAY_PRIVATE_KEY_FILE: join(dir, 'alipay-private.pem'),
    PAY_ALIPAY_PUBLIC_KEY_FILE: join(dir, 'alipay-public.pem'),
  };
}

/** 完整的 staging 环境：微信测试商户 + 支付宝沙箱网关。 */
export function stagingEnv(dir: string): Record<string, string> {
  return {
    ...baseEnv('staging'),
    ...commonEnv(),
    ...wechatEnv(dir),
    PAY_WECHAT_TEST_MERCHANT: '1',
    ...alipayEnv(dir),
    PAY_ALIPAY_GATEWAY: SANDBOX_GATEWAY,
  };
}

export function prodEnv(dir: string): Record<string, string> {
  return { ...baseEnv('prod'), ...commonEnv(), ...wechatEnv(dir), ...alipayEnv(dir) };
}

export async function channelSetOf(config: AppConfig, route: Route = NO_NETWORK) {
  const { calls, transport } = transportOf(route);
  const logs: string[] = [];
  const set = await createPayChannelSet(config, {
    transport,
    clock: new FixedClock(NOW),
    logger: captureLogger(logs),
  });
  return { set, calls, logs };
}

export function warnLines(logs: readonly string[]): readonly string[] {
  return logs.filter((line) => (JSON.parse(line) as { level?: unknown }).level === 40);
}

// ---- 默认 transport 的假服务端（只听 127.0.0.1，随机端口；任务书 9.12 允许）

export async function withServer(
  listener: RequestListener,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

// ---- 错误映射表

/** 带引号的 CSV（meaning 里可能有逗号）；不处理跨行字段。 */
export function parseCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const cells: string[] = [];
      let cell = '';
      let quoted = false;
      for (let i = 0; i < line.length; i += 1) {
        const c = line[i] ?? '';
        if (quoted && c === '"' && line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else if (c === '"') {
          quoted = !quoted;
        } else if (c === ',' && !quoted) {
          cells.push(cell);
          cell = '';
        } else {
          cell += c;
        }
      }
      cells.push(cell);
      return cells;
    });
}

export const ROOT = new URL('../../../../', import.meta.url);
