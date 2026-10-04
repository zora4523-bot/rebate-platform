import {
  constants,
  createCipheriv,
  createSign,
  createVerify,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
} from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { HttpRequest, HttpResponse, Transport } from '../transport.ts';
import { WechatPayClient } from './client.ts';
import {
  decryptWechatResource,
  encryptSensitive,
  verifyWechatSignature,
  wechatAuthorization,
} from './crypto.ts';

const pem = { type: 'pkcs8', format: 'pem' } as const;
const spki = { type: 'spki', format: 'pem' } as const;
const merchant = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: pem,
  publicKeyEncoding: spki,
});
const platform = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: pem,
  publicKeyEncoding: spki,
});
// Random per run: a fixed 32-character literal trips the secret scanner.
const API_V3_KEY = randomBytes(16).toString('hex');
const NOW = 1_780_000_000;

function platformSign(timestamp: string, nonce: string, body: string): string {
  return createSign('RSA-SHA256')
    .update(`${timestamp}\n${nonce}\n${body}\n`)
    .sign(platform.privateKey, 'base64');
}

function signedResponse(status: number, body: string): HttpResponse {
  const timestamp = String(NOW);
  return {
    status,
    headers: {
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': 'resp-nonce',
      'wechatpay-signature': platformSign(timestamp, 'resp-nonce', body),
      'wechatpay-serial': 'PUB_KEY_ID_TEST',
    },
    body,
  };
}

function client(transport: Transport): WechatPayClient {
  return new WechatPayClient({
    mchid: '1900000001',
    appid: 'wxtestappid000001',
    serialNo: 'SERIAL001',
    privateKeyPem: merchant.privateKey,
    platformPublicKeyPem: platform.publicKey,
    platformPublicKeyId: 'PUB_KEY_ID_TEST',
    apiV3Key: API_V3_KEY,
    transport,
    now: () => NOW,
    nonce: () => 'fixed-nonce',
  });
}

function encryptResource(plain: string, nonce: string, aad: string): string {
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(API_V3_KEY), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([enc, cipher.getAuthTag()]).toString('base64');
}

describe('wechat pay primitives', () => {
  it('builds an Authorization header whose signature covers method, path, time, nonce and body', () => {
    const header = wechatAuthorization({
      mchid: '1900000001',
      serialNo: 'SERIAL001',
      privateKeyPem: merchant.privateKey,
      method: 'POST',
      pathWithQuery: '/v3/pay/transactions/app',
      body: '{"a":1}',
      timestamp: NOW,
      nonce: 'n1',
    });
    expect(
      header.startsWith('WECHATPAY2-SHA256-RSA2048 mchid="1900000001",nonce_str="n1",signature="'),
    ).toBe(true);
    const signature = /signature="([^"]+)"/.exec(header)?.[1] ?? '';
    const message = `POST\n/v3/pay/transactions/app\n${String(NOW)}\nn1\n{"a":1}\n`;
    expect(
      createVerify('RSA-SHA256').update(message).verify(merchant.publicKey, signature, 'base64'),
    ).toBe(true);
  });

  it('rejects tampered bodies and probe signatures', () => {
    const signature = platformSign('1', 'n', 'body');
    const base = { publicKeyPem: platform.publicKey, timestamp: '1', nonce: 'n' };
    expect(verifyWechatSignature({ ...base, body: 'body', signature })).toBe(true);
    expect(verifyWechatSignature({ ...base, body: 'body2', signature })).toBe(false);
    expect(
      verifyWechatSignature({
        ...base,
        body: 'body',
        signature: `WECHATPAY/SIGNTEST/${signature}`,
      }),
    ).toBe(false);
  });

  it('decrypts a notification resource and fails on a wrong tag', () => {
    const ciphertext = encryptResource('{"out_trade_no":"P1"}', 'nonce12chars', 'transaction');
    const resource = {
      algorithm: 'AEAD_AES_256_GCM',
      ciphertext,
      nonce: 'nonce12chars',
      associated_data: 'transaction',
    };
    expect(decryptWechatResource(API_V3_KEY, resource)).toBe('{"out_trade_no":"P1"}');
    expect(() =>
      decryptWechatResource(API_V3_KEY, { ...resource, associated_data: 'other' }),
    ).toThrow();
  });

  it('encrypts sensitive fields so that only the platform key can read them', () => {
    const enc = encryptSensitive(platform.publicKey, '张三');
    const dec = privateDecrypt(
      { key: platform.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
      Buffer.from(enc, 'base64'),
    );
    expect(dec.toString('utf8')).toBe('张三');
  });
});

describe('wechat pay client', () => {
  it('creates an APP order and returns verified data', async () => {
    const seen: HttpRequest[] = [];
    const c = client((req) => {
      seen.push(req);
      return Promise.resolve(
        signedResponse(200, '{"prepay_id":"wx201410272009395522657a690389285100"}'),
      );
    });
    const r = await c.createAppOrder({
      outTradeNo: 'P20261004A1',
      description: '测试',
      totalFen: 1,
      notifyUrl: 'https://example.test/notify/pay/wechat',
    });
    expect(r).toMatchObject({
      kind: 'ok',
      data: { prepay_id: 'wx201410272009395522657a690389285100' },
    });
    const sent = JSON.parse(seen[0]?.body ?? '{}') as { amount: { total: number }; mchid: string };
    expect(sent.amount.total).toBe(1);
    expect(sent.mchid).toBe('1900000001');
    expect(seen[0]?.url).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/app');
  });

  it('signs launch parameters with the documented message', () => {
    const p = client(() => Promise.reject(new Error('unused'))).buildAppPayParams('prepay123');
    const message = `wxtestappid000001\n${String(NOW)}\nfixed-nonce\nprepay123\n`;
    expect(
      createVerify('RSA-SHA256').update(message).verify(merchant.publicKey, p.sign, 'base64'),
    ).toBe(true);
    expect(p).toMatchObject({
      partnerId: '1900000001',
      packageValue: 'Sign=WXPay',
      timeStamp: String(NOW),
    });
  });

  it('treats an unverifiable 2xx answer as unknown, never as success', async () => {
    const c = client(() =>
      Promise.resolve({ ...signedResponse(200, '{"state":"SUCCESS"}'), body: '{"state":"FAIL"}' }),
    );
    expect(await c.queryTransfer('W1')).toEqual({
      kind: 'unknown',
      reason: 'bad_signature',
      detail: '200',
    });
  });

  it('maps business errors, 5xx, throttling and timeouts', async () => {
    const rejected = await client(() =>
      Promise.resolve({ status: 400, headers: {}, body: '{"code":"PARAM_ERROR","message":"bad"}' }),
    ).closeOrder('P1');
    expect(rejected).toMatchObject({ kind: 'rejected', code: 'PARAM_ERROR', httpStatus: 400 });
    const fiveXx = await client(() =>
      Promise.resolve({ status: 500, headers: {}, body: '{"code":"SYSTEM_ERROR"}' }),
    ).queryOrder('P1');
    expect(fiveXx).toEqual({ kind: 'unknown', reason: 'http_5xx', detail: '500' });
    const throttled = await client(() =>
      Promise.resolve({ status: 429, headers: {}, body: '' }),
    ).queryOrder('P1');
    expect(throttled).toEqual({ kind: 'unknown', reason: 'throttled', detail: '429' });
    const timeout = await client(() =>
      Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })),
    ).createTransfer({
      outBillNo: 'W1',
      transferSceneId: '1005',
      openid: 'o1',
      amountFen: 100,
      remark: 'r',
      sceneReportInfos: [],
    });
    expect(timeout).toEqual({ kind: 'unknown', reason: 'timeout', detail: 'TimeoutError' });
  });

  it('encrypts the payee name and names the key id when a transfer carries one', async () => {
    const seen: HttpRequest[] = [];
    const c = client((req) => {
      seen.push(req);
      return Promise.resolve(
        signedResponse(200, '{"state":"WAIT_USER_CONFIRM","package_info":"pkg"}'),
      );
    });
    await c.createTransfer({
      outBillNo: 'W2',
      transferSceneId: '1005',
      openid: 'o1',
      amountFen: 100,
      remark: 'r',
      sceneReportInfos: [{ infoType: '岗位类型', infoContent: '推广' }],
      userName: '张三',
    });
    const body = JSON.parse(seen[0]?.body ?? '{}') as {
      user_name: string;
      transfer_amount: number;
    };
    expect(body.user_name).not.toContain('张三');
    expect(body.transfer_amount).toBe(100);
    expect(seen[0]?.headers['Wechatpay-Serial']).toBe('PUB_KEY_ID_TEST');
    expect(c.buildTransferConfirmQuery('a b&c')).toBe(
      'mchId=1900000001&appId=wxtestappid000001&package=a%20b%26c',
    );
  });

  it('rejects non-positive and fractional amounts before any request', () => {
    const c = client(() => Promise.reject(new Error('must not be called')));
    expect(() =>
      c.createAppOrder({
        outTradeNo: 'P',
        description: 'd',
        totalFen: 0,
        notifyUrl: 'https://example.test',
      }),
    ).toThrow(RangeError);
    expect(() =>
      c.refund({ outTradeNo: 'P', outRefundNo: 'R', refundFen: 1.5, totalFen: 2 }),
    ).toThrow(RangeError);
  });

  it('verifies and decrypts notifications, and refuses stale, foreign or forged ones', () => {
    const c = client(() => Promise.reject(new Error('unused')));
    const body = JSON.stringify({
      id: 'EV-1',
      event_type: 'TRANSACTION.SUCCESS',
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        ciphertext: encryptResource(
          '{"out_trade_no":"P1","amount":{"total":1}}',
          'nonce12chars',
          'transaction',
        ),
        nonce: 'nonce12chars',
        associated_data: 'transaction',
      },
    });
    const headers = {
      'wechatpay-timestamp': String(NOW),
      'wechatpay-nonce': 'n9',
      'wechatpay-signature': platformSign(String(NOW), 'n9', body),
      'wechatpay-serial': 'PUB_KEY_ID_TEST',
    };
    expect(c.parseNotification(headers, body)).toEqual({
      ok: true,
      notification: {
        id: 'EV-1',
        eventType: 'TRANSACTION.SUCCESS',
        resource: { out_trade_no: 'P1', amount: { total: 1 } },
      },
    });
    expect(c.parseNotification(headers, body.replace('EV-1', 'EV-2'))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(c.parseNotification({ ...headers, 'wechatpay-serial': 'OTHER' }, body)).toEqual({
      ok: false,
      reason: 'wrong_key_id',
    });
    const old = String(NOW - 301);
    expect(
      c.parseNotification(
        {
          ...headers,
          'wechatpay-timestamp': old,
          'wechatpay-signature': platformSign(old, 'n9', body),
        },
        body,
      ),
    ).toEqual({ ok: false, reason: 'stale' });
  });
});
