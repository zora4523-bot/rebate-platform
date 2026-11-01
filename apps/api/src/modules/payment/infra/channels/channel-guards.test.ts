// B2-15k: implementer's unit tests: an order of another App never reaches a channel; WeChat Pay's
// query of an unpaid trade without amount.total still answers (4013070356.txt:500, total optional).
import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FixedClock, createRootLogger } from '../../../platform/index.ts';
import { AlipayPayChannel } from './alipay/alipay-pay-channel.ts';
import type { PayHttpResponse, PayTransport } from './transport.ts';
import { WechatPayChannel } from './wechat/wechat-pay-channel.ts';

const options = {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
} as const;
const merchant = generateKeyPairSync('rsa', options);
const platform = generateKeyPairSync('rsa', options);

const NOW = new Date('2026-11-01T04:00:00.000Z');
const NOW_S = String(Math.floor(NOW.getTime() / 1000));
const PAY_APP_ID = 'couli-app-test';
const OUT = 'P1';
const MCHID = 'M1';
const APPID = 'A1';
const logger = createRootLogger(
  { entry: 'api', appEnv: 'test', level: 'silent' },
  { write: () => undefined },
);

function signed(status: number, body: object): PayHttpResponse {
  const text = JSON.stringify(body);
  return {
    status,
    body: text,
    headers: {
      'wechatpay-timestamp': NOW_S,
      'wechatpay-nonce': 'n',
      'wechatpay-serial': 'KEY',
      'wechatpay-signature': createSign('RSA-SHA256')
        .update(`${NOW_S}\nn\n${text}\n`, 'utf8')
        .sign(platform.privateKey, 'base64'),
    },
  };
}

function wechat(answer: () => PayHttpResponse) {
  let calls = 0;
  const transport: PayTransport = () => {
    calls += 1;
    return Promise.resolve(answer());
  };
  const channel = new WechatPayChannel({
    config: {
      payAppId: PAY_APP_ID,
      appId: APPID,
      mchId: MCHID,
      merchantSerial: 'S',
      publicKeyId: 'KEY',
      notifyBaseUrl: 'https://pay.example.test',
    },
    keys: {
      privateKeyPem: merchant.privateKey,
      apiV3Key: 'k'.repeat(32),
      publicKeyPem: platform.publicKey,
    },
    transport,
    clock: new FixedClock(NOW),
    logger,
  });
  return { channel, calls: () => calls };
}

function alipay() {
  return new AlipayPayChannel({
    config: {
      payAppId: PAY_APP_ID,
      appId: 'A2',
      sellerId: 'S2',
      gateway: 'https://gateway.example.test/gateway.do',
      notifyBaseUrl: 'https://pay.example.test',
      certSerials: null,
    },
    keys: { privateKeyPem: merchant.privateKey, alipayPublicKeyPem: platform.publicKey },
    transport: () => Promise.reject(new Error('unexpected channel call')),
    clock: new FixedClock(NOW),
    logger,
  });
}

const ORDER = {
  outTradeNo: OUT,
  amountFen: 100n,
  description: 'title',
  expireAt: new Date('2026-11-01T04:15:00.000Z'),
  notifyUrl: '/notify/pay/wechat',
};
const UNPAID = { appid: APPID, mchid: MCHID, out_trade_no: OUT, trade_state: 'NOTPAY' };

describe('createOrder and the app of the order', () => {
  it('[AC-B2-15k-U#60] WeChat Pay: another App is app_not_configured, the channel is not called', async () => {
    const h = wechat(() => signed(200, { prepay_id: 'p' }));
    expect(await h.channel.createOrder({ ...ORDER, appId: 'other-app' })).toEqual({
      kind: 'unknown',
      reason: 'app_not_configured',
    });
    expect(h.calls()).toBe(0);
  });

  it('[AC-B2-15k-U#61] WeChat Pay: the configured App, or none given, is placed', async () => {
    const h = wechat(() => signed(200, { prepay_id: 'p' }));
    expect((await h.channel.createOrder({ ...ORDER, appId: PAY_APP_ID })).kind).toBe('ok');
    expect((await h.channel.createOrder(ORDER)).kind).toBe('ok');
    expect(h.calls()).toBe(2);
  });

  it('[AC-B2-15k-U#62] Alipay: another App is app_not_configured, no order string; the configured App signs', async () => {
    expect(await alipay().createOrder({ ...ORDER, appId: 'other-app' })).toEqual({
      kind: 'unknown',
      reason: 'app_not_configured',
    });
    expect((await alipay().createOrder({ ...ORDER, appId: PAY_APP_ID })).kind).toBe('ok');
  });
});

describe('WeChat Pay query and amount.total', () => {
  it('[AC-B2-15k-U#63] an unpaid trade whose amount has no total answers, without an amount', async () => {
    const h = wechat(() => signed(200, { ...UNPAID, amount: { currency: 'CNY' } }));
    expect(await h.channel.query(OUT)).toMatchObject({
      kind: 'ok',
      state: 'not_paid',
      channelState: 'NOTPAY',
      amountFen: null,
    });
  });

  it('[AC-B2-15k-U#64] a close of such a trade that is closed by then is closed', async () => {
    const closed = { ...UNPAID, trade_state: 'CLOSED', amount: {} };
    let first = true;
    const h = wechat(() => {
      if (first) {
        first = false;
        return { ...signed(204, {}), ...empty() };
      }
      return signed(200, closed);
    });
    expect(await h.channel.close(OUT)).toEqual({ kind: 'ok', state: 'closed' });
  });

  it('[AC-B2-15k-U#65] a total that is there is still checked strictly, on an unpaid trade too', async () => {
    for (const total of [-1, 0, 1.5, '100', null]) {
      const h = wechat(() => signed(200, { ...UNPAID, amount: { total, currency: 'CNY' } }));
      expect((await h.channel.query(OUT)).kind).toBe('unknown');
    }
  });

  it('[AC-B2-15k-U#66] a paid trade must still have its total', async () => {
    const paid = { ...UNPAID, trade_state: 'SUCCESS', transaction_id: 'T1', amount: {} };
    const h = wechat(() => signed(200, paid));
    expect((await h.channel.query(OUT)).kind).toBe('unknown');
  });
});

/** An empty 204 under a signature over the empty body. */
function empty(): Pick<PayHttpResponse, 'body' | 'headers'> {
  return {
    body: '',
    headers: {
      'wechatpay-timestamp': NOW_S,
      'wechatpay-nonce': 'n',
      'wechatpay-serial': 'KEY',
      'wechatpay-signature': createSign('RSA-SHA256')
        .update(`${NOW_S}\nn\n\n`, 'utf8')
        .sign(platform.privateKey, 'base64'),
    },
  };
}
