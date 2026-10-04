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

function signedResponse(status: number, body: string, at: number = NOW): HttpResponse {
  const timestamp = String(at);
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
  const transferInput = {
    outBillNo: 'W1',
    transferSceneId: '1005',
    openid: 'o1',
    amountFen: 100,
    remark: 'r',
    sceneReportInfos: [],
  };
  const answer =
    (res: HttpResponse): Transport =>
    () =>
      Promise.resolve(res);
  const bill = (no: string, state: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ out_bill_no: no, transfer_bill_no: 'T1', state, ...extra });
  const queried = (no: string, state: string, extra: Record<string, unknown> = {}): string =>
    bill(no, state, {
      mch_id: '1900000001',
      appid: 'wxtestappid000001',
      transfer_amount: 100,
      ...extra,
    });
  const order = (no: string, state: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      appid: 'wxtestappid000001',
      mchid: '1900000001',
      out_trade_no: no,
      trade_state: state,
      ...extra,
    });
  const appOrder = {
    outTradeNo: 'P1',
    description: 'd',
    totalFen: 1,
    notifyUrl: 'https://example.test/n',
  };

  it('creates an APP order and returns verified data', async () => {
    const seen: HttpRequest[] = [];
    const c = client((req) => {
      seen.push(req);
      return Promise.resolve(
        signedResponse(200, '{"prepay_id":"wx201410272009395522657a690389285100"}'),
      );
    });
    expect(await c.createAppOrder(appOrder)).toEqual({
      kind: 'ok',
      data: { prepay_id: 'wx201410272009395522657a690389285100' },
    });
    const sent = JSON.parse(seen[0]?.body ?? '{}') as { amount: { total: number }; mchid: string };
    expect(sent.amount.total).toBe(1);
    expect(sent.mchid).toBe('1900000001');
    expect(seen[0]?.url).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/app');
  });

  it('names the public key id on every request, with or without encrypted fields', async () => {
    const seen: HttpRequest[] = [];
    const c = client((req) => {
      seen.push(req);
      return Promise.resolve(signedResponse(204, ''));
    });
    await c.closeOrder('P1');
    await c.queryOrder('P1');
    await c.createTransfer(transferInput);
    expect(seen.map((r) => r.headers['Wechatpay-Serial'])).toEqual([
      'PUB_KEY_ID_TEST',
      'PUB_KEY_ID_TEST',
      'PUB_KEY_ID_TEST',
    ]);
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
    const tampered = {
      ...signedResponse(200, queried('W1', 'SUCCESS')),
      body: queried('W1', 'FAIL'),
    };
    expect(await client(answer(tampered)).queryTransfer('W1')).toMatchObject({
      kind: 'unknown',
      reason: 'bad_signature',
    });
  });

  it('refuses stale, future, foreign-key and header-less answers even when the signature is valid', async () => {
    const body = queried('W1', 'SUCCESS');
    const fresh = signedResponse(200, body);
    const cases: [string, HttpResponse][] = [
      ['a day old', signedResponse(200, body, NOW - 86_400)],
      ['exactly five minutes old', signedResponse(200, body, NOW - 300)],
      ['from the future', signedResponse(200, body, NOW + 3_600)],
      [
        'other key id',
        { ...fresh, headers: { ...fresh.headers, 'wechatpay-serial': 'PUB_KEY_ID_OTHER' } },
      ],
      ['no key id', { ...fresh, headers: { ...fresh.headers, 'wechatpay-serial': '' } }],
      ['no signature headers', { status: 200, headers: {}, body }],
    ];
    for (const [name, res] of cases) {
      expect(await client(answer(res)).queryTransfer('W1'), name).toMatchObject({
        kind: 'unknown',
        reason: 'bad_signature',
      });
    }
    expect(
      await client(answer(signedResponse(200, body, NOW - 299))).queryTransfer('W1'),
    ).toMatchObject({
      kind: 'ok',
      data: { state: 'SUCCESS' },
    });
  });

  it('does not accept a valid answer that belongs to another bill, merchant or app', async () => {
    const other = signedResponse(200, queried('W_OLD', 'SUCCESS'));
    expect(await client(answer(other)).queryTransfer('W_NEW')).toMatchObject({
      kind: 'unknown',
      reason: 'bad_body',
      detail: '200 mismatched out_bill_no',
    });
    const otherMch = signedResponse(200, queried('W1', 'SUCCESS', { mch_id: '1900000999' }));
    expect(await client(answer(otherMch)).queryTransfer('W1')).toMatchObject({
      kind: 'unknown',
      reason: 'bad_body',
    });
    const otherOrder = signedResponse(200, order('P_OLD', 'SUCCESS'));
    expect(await client(answer(otherOrder)).queryOrder('P_NEW')).toMatchObject({
      kind: 'unknown',
      reason: 'bad_body',
    });
    const refund = JSON.stringify({
      refund_id: 'r',
      out_refund_no: 'R_OLD',
      out_trade_no: 'P1',
      status: 'SUCCESS',
      amount: {},
    });
    expect(await client(answer(signedResponse(200, refund))).queryRefund('R_NEW')).toMatchObject({
      kind: 'unknown',
      reason: 'bad_body',
    });
  });

  it('never turns an unsigned or wrongly signed error into a rejection', async () => {
    const error = '{"code":"PARAM_ERROR","message":"bad"}';
    const unsigned = await client(answer({ status: 400, headers: {}, body: error })).createTransfer(
      transferInput,
    );
    expect(unsigned).toEqual({
      kind: 'unknown',
      reason: 'bad_signature',
      detail: '400 bad_signature',
      code: 'PARAM_ERROR',
    });
    const wrong = { ...signedResponse(400, error), body: '{"code":"NOT_ENOUGH","message":"x"}' };
    expect(await client(answer(wrong)).createTransfer(transferInput)).toMatchObject({
      kind: 'unknown',
      reason: 'bad_signature',
    });
  });

  it('rejects only allowlisted codes; every other verified code is indeterminate', async () => {
    const run = (status: number, code: string) =>
      client(answer(signedResponse(status, `{"code":"${code}","message":"m"}`))).createTransfer(
        transferInput,
      );
    expect(await run(400, 'PARAM_ERROR')).toEqual({
      kind: 'rejected',
      code: 'PARAM_ERROR',
      message: 'm',
      httpStatus: 400,
    });
    expect(await run(403, 'NOT_ENOUGH')).toMatchObject({ kind: 'rejected', code: 'NOT_ENOUGH' });
    const indeterminate = [
      'ALREADY_EXISTS',
      'SYSTEM_ERROR',
      'NOT_FOUND',
      'ORDER_NOT_EXIST',
      'OUT_TRADE_NO_USED',
      'RESOURCE_NOT_EXISTS',
      'A_CODE_NOBODY_HAS_SEEN',
    ];
    for (const code of indeterminate) {
      expect(await run(400, code), code).toEqual({
        kind: 'unknown',
        reason: 'indeterminate',
        detail: '400',
        code,
      });
    }
    expect(
      await client(answer(signedResponse(400, '{"message":"no code"}'))).createTransfer(
        transferInput,
      ),
    ).toMatchObject({ kind: 'unknown', reason: 'bad_body' });
  });

  it('checks the shape each call requires, even when the signature is valid', async () => {
    const q = (body: string, status = 200) =>
      client(answer(signedResponse(status, body))).queryTransfer('W1');
    expect(await q('', 204)).toMatchObject({ kind: 'unknown', reason: 'bad_body' });
    expect(await q('null')).toMatchObject({ kind: 'unknown', reason: 'bad_body' });
    expect(await q(bill('W1', 'SUCCESS'))).toMatchObject({
      kind: 'unknown',
      detail: '200 missing transfer_amount',
    });
    expect(await q(queried('W1', 'SUCCESS', { transfer_amount: '100' }))).toMatchObject({
      kind: 'unknown',
    });
    expect(await q(queried('W1', 'A_NEW_STATE'))).toMatchObject({
      kind: 'unknown',
      detail: '200 unexpected state',
    });
    expect(await q(queried('W1', 'SUCCESS', { code: 'SYSTEM_ERROR' }))).toMatchObject({
      kind: 'unknown',
      reason: 'bad_body',
      detail: '200 success with a code',
    });
    expect(
      await client(answer(signedResponse(200, '{"out_trade_no":"P1"}'))).queryOrder('P1'),
    ).toMatchObject({
      kind: 'unknown',
      reason: 'bad_body',
    });
    expect(await client(answer(signedResponse(200, '{}'))).createAppOrder(appOrder)).toMatchObject({
      kind: 'unknown',
      reason: 'bad_body',
    });
    // closing an order succeeds only with a verified, empty 204
    expect(await client(answer(signedResponse(204, ''))).closeOrder('P1')).toEqual({
      kind: 'ok',
      data: {},
    });
    expect(await client(answer(signedResponse(200, '{"x":"y"}'))).closeOrder('P1')).toMatchObject({
      kind: 'unknown',
      reason: 'bad_body',
    });
    expect(
      await client(answer(signedResponse(200, order('P1', 'NOTPAY')))).queryOrder('P1'),
    ).toMatchObject({
      kind: 'ok',
      data: { trade_state: 'NOTPAY' },
    });
  });

  it('maps 5xx, throttling and timeouts to unknown, keeping a readable code', async () => {
    expect(
      await client(
        answer({ status: 500, headers: {}, body: '{"code":"SYSTEM_ERROR"}' }),
      ).queryOrder('P1'),
    ).toEqual({ kind: 'unknown', reason: 'http_5xx', detail: '500', code: 'SYSTEM_ERROR' });
    expect(await client(answer({ status: 429, headers: {}, body: '' })).queryOrder('P1')).toEqual({
      kind: 'unknown',
      reason: 'throttled',
      detail: '429',
    });
    const timeout = await client(() =>
      Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })),
    ).createTransfer(transferInput);
    expect(timeout).toEqual({ kind: 'unknown', reason: 'timeout', detail: 'TimeoutError' });
  });

  it('encrypts the payee name when a transfer carries one', async () => {
    const seen: HttpRequest[] = [];
    const c = client((req) => {
      seen.push(req);
      return Promise.resolve(
        signedResponse(200, bill('W2', 'WAIT_USER_CONFIRM', { package_info: 'pkg' })),
      );
    });
    const r = await c.createTransfer({
      ...transferInput,
      outBillNo: 'W2',
      sceneReportInfos: [{ infoType: '岗位类型', infoContent: '推广' }],
      userName: '张三',
    });
    expect(r).toMatchObject({ kind: 'ok', data: { state: 'WAIT_USER_CONFIRM' } });
    const body = JSON.parse(seen[0]?.body ?? '{}') as {
      user_name: string;
      transfer_amount: number;
    };
    expect(body.user_name).not.toContain('张三');
    expect(body.transfer_amount).toBe(100);
    expect(c.buildTransferConfirmQuery('a b&c')).toBe(
      'mchId=1900000001&appId=wxtestappid000001&package=a%20b%26c',
    );
  });

  it('rejects non-positive and fractional amounts before any request', () => {
    const c = client(() => Promise.reject(new Error('must not be called')));
    expect(() => c.createAppOrder({ ...appOrder, totalFen: 0 })).toThrow(RangeError);
    expect(() =>
      c.refund({ outTradeNo: 'P', outRefundNo: 'R', refundFen: 1.5, totalFen: 2 }),
    ).toThrow(RangeError);
  });

  it('verifies and decrypts notifications, and refuses stale, foreign, forged or non-object ones', () => {
    const c = client(() => Promise.reject(new Error('unused')));
    const make = (plain: string): { headers: Record<string, string>; body: string } => {
      const body = JSON.stringify({
        id: 'EV-1',
        event_type: 'TRANSACTION.SUCCESS',
        resource: {
          algorithm: 'AEAD_AES_256_GCM',
          ciphertext: encryptResource(plain, 'nonce12chars', 'transaction'),
          nonce: 'nonce12chars',
          associated_data: 'transaction',
        },
      });
      return {
        body,
        headers: {
          'wechatpay-timestamp': String(NOW),
          'wechatpay-nonce': 'n9',
          'wechatpay-signature': platformSign(String(NOW), 'n9', body),
          'wechatpay-serial': 'PUB_KEY_ID_TEST',
        },
      };
    };
    const { headers, body } = make('{"out_trade_no":"P1","amount":{"total":1}}');
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
    for (const plain of ['null', '[]', '"text"']) {
      const n = make(plain);
      expect(c.parseNotification(n.headers, n.body), plain).toEqual({
        ok: false,
        reason: 'bad_body',
      });
    }
  });
});
