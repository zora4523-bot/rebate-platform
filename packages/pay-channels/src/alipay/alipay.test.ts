import { createVerify, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { HttpRequest, Transport } from '../transport.ts';
import { AlipayClient, extractJsonNode } from './client.ts';
import {
  alipaySignContent,
  alipayTimestamp,
  certSn,
  publicKeyFromCert,
  rootCertSn,
  rsa2Sign,
  rsa2Verify,
} from './crypto.ts';

const pem = { type: 'pkcs8', format: 'pem' } as const;
const spki = { type: 'spki', format: 'pem' } as const;
const app = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: pem,
  publicKeyEncoding: spki,
});
const alipay = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: pem,
  publicKeyEncoding: spki,
});

// Self-signed test certificate (no real identity). Expected serial number computed independently
// with: openssl x509 -issuer -nameopt RFC2253 / -serial, then md5(issuer + decimal serial).
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDdzCCAl+gAwIBAgIUS4oUjkG9mbEOpf/VfJEt8StMLhswDQYJKoZIhvcNAQEL
BQAwSzELMAkGA1UEBhMCQ04xEzARBgNVBAoMCkNvdWxpIFRlc3QxDTALBgNVBAsM
BFVuaXQxGDAWBgNVBAMMD2NvdWxpLXRlc3Qtcm9vdDAeFw0yNjEwMDQwOTQ4NDBa
Fw0zNjEwMDEwOTQ4NDBaMEsxCzAJBgNVBAYTAkNOMRMwEQYDVQQKDApDb3VsaSBU
ZXN0MQ0wCwYDVQQLDARVbml0MRgwFgYDVQQDDA9jb3VsaS10ZXN0LXJvb3QwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDH4itL749SXdUsC2gsYwvCbPp6
2tsGU9Hz5tx0p3ADsmVNc3nVFslOpl/lt6EtIIsfryfJ9lixMiKipmInHLiRCEfx
S0AhuTe40KWCgqzaKW0inDNV3e2vaVVeJaCZj3DgOQcW76sRReioHIH5VIyHttOJ
BD2HEIr2WD+2VPxjKmV04nc7zW+cHDS7ER/rOWFfakHuBsFXifLunDTTcRGoWimr
VVY4Ya2WsbAC5DQ91dUN5ONZwSalk0xJp6o/yT1LAuq/P5NOW9CO31KijBVw13uV
qYbA3WrXh/lNzgV15/UjsnxgRjEFXLl5snL970AAg2XhDQc3wiXpQ9VQ6RYLAgMB
AAGjUzBRMB0GA1UdDgQWBBSEeeBfflr6cxa0URDRJ15UBdGUuDAfBgNVHSMEGDAW
gBSEeeBfflr6cxa0URDRJ15UBdGUuDAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3
DQEBCwUAA4IBAQCd4AHbDjYf1LPHCI7imvT4GdV/gXSoD3QeC66pxUQHhMSyq1xY
i2nFpBB6hopdDIVGTtnAwc44aSl6P5jP9DhRALLqNAoNRv72wtQu1GWkDx49nAt0
1h+2l7snN/CZ/L8MKY1LfdZyN/F3dQE9t6tURNUu6gascJJhLQRfSOF89SYAuo1H
sk3g3ORnQjOSE1TAqfx2OMCKCaBqKquuB4cxjFlEcNzuzgKjna4prItH6S3sUwdE
npbBzp2MCm/97zeP0W65++YHDjteToQw82KpqsgnWA4ItNa45P1GWx8N0eEQtVWQ
0+IcUqRC4QAexnFbaY9XfVquX8donEWldLc4
-----END CERTIFICATE-----`;
const TEST_CERT_SN = '979dbccf57adac9cff9789e05cb62ef1';

function client(transport: Transport): AlipayClient {
  return new AlipayClient({
    appId: '2021000000000001',
    privateKeyPem: app.privateKey,
    appCertSn: 'app-sn',
    alipayRootCertSn: 'root-sn',
    alipayPublicKeyPem: alipay.publicKey,
    transport,
    now: () => Date.UTC(2026, 9, 4, 8, 30, 5),
  });
}

function signedBody(
  nodeKey: string,
  node: string,
  sign = rsa2Sign(node, alipay.privateKey),
): string {
  return `{"${nodeKey}":${node},"alipay_cert_sn":"x","sign":"${sign}"}`;
}

describe('alipay primitives', () => {
  it('builds the string to sign: sorted, no sign, no empty values', () => {
    expect(alipaySignContent({ b: '2', a: '1', sign: 'x', c: '', d: undefined })).toBe('a=1&b=2');
  });

  it('signs and verifies with RSA2', () => {
    const s = rsa2Sign('a=1&b=中文', app.privateKey);
    expect(rsa2Verify('a=1&b=中文', s, app.publicKey)).toBe(true);
    expect(rsa2Verify('a=1&b=中文!', s, app.publicKey)).toBe(false);
    expect(rsa2Verify('a=1', 'not-base64-signature', app.publicKey)).toBe(false);
  });

  it('computes certificate serial numbers the way openssl + md5 does', () => {
    expect(certSn(TEST_CERT)).toBe(TEST_CERT_SN);
    expect(rootCertSn(`${TEST_CERT}\n${TEST_CERT}`)).toBe(`${TEST_CERT_SN}_${TEST_CERT_SN}`);
    expect(publicKeyFromCert(TEST_CERT)).toContain('BEGIN PUBLIC KEY');
  });

  it('formats timestamps in +08:00', () => {
    expect(alipayTimestamp(Date.UTC(2026, 9, 4, 16, 0, 0))).toBe('2026-10-05 00:00:00');
  });

  it('extracts a response node byte for byte', () => {
    const raw = '{"x_response":{"code":"10000","msg":"a}\\"b","n":{"k":1}},"sign":"s"}';
    expect(extractJsonNode(raw, 'x_response')).toBe('{"code":"10000","msg":"a}\\"b","n":{"k":1}}');
    expect(extractJsonNode(raw, 'missing')).toBeUndefined();
  });
});

describe('alipay client', () => {
  it('builds a signed APP pay order string with the amount in yuan', () => {
    const orderStr = client(() => Promise.reject(new Error('unused'))).buildAppPayOrderString({
      outTradeNo: 'P20261004A1',
      totalFen: 1,
      subject: '测试',
      notifyUrl: 'https://example.test/notify/pay/alipay',
    });
    const params = Object.fromEntries(new URLSearchParams(orderStr));
    expect(params['method']).toBe('alipay.trade.app.pay');
    expect(params['timestamp']).toBe('2026-10-04 16:30:05');
    expect(JSON.parse(params['biz_content'] ?? '{}')).toMatchObject({
      total_amount: '0.01',
      product_code: 'QUICK_MSECURITY_PAY',
    });
    const signature = params['sign'] ?? '';
    expect(
      createVerify('RSA-SHA256')
        .update(alipaySignContent(params))
        .verify(app.publicKey, signature, 'base64'),
    ).toBe(true);
  });

  it('returns ok only for a verified 10000 answer', async () => {
    const seen: HttpRequest[] = [];
    const node = '{"code":"10000","msg":"Success","status":"SUCCESS","order_id":"2026"}';
    const c = client((req) => {
      seen.push(req);
      return Promise.resolve({
        status: 200,
        headers: {},
        body: signedBody('alipay_fund_trans_common_query_response', node),
      });
    });
    expect(await c.transferQuery('W1')).toMatchObject({ kind: 'ok', data: { status: 'SUCCESS' } });
    const sent = Object.fromEntries(new URLSearchParams(seen[0]?.body ?? ''));
    expect(JSON.parse(sent['biz_content'] ?? '{}')).toEqual({
      out_biz_no: 'W1',
      product_code: 'TRANS_ACCOUNT_NO_PWD',
      biz_scene: 'DIRECT_TRANSFER',
    });
  });

  it('never trusts an answer whose signature does not match', async () => {
    const node = '{"code":"10000","msg":"Success","status":"SUCCESS"}';
    const forged = signedBody(
      'alipay_fund_trans_uni_transfer_response',
      node,
      rsa2Sign(node, app.privateKey),
    );
    const r = await client(() =>
      Promise.resolve({ status: 200, headers: {}, body: forged }),
    ).transfer({
      outBizNo: 'W2',
      amountFen: 10,
      payeeLogonId: 'a@example.test',
      payeeName: '张三',
      orderTitle: 't',
    });
    expect(r).toEqual({ kind: 'unknown', reason: 'bad_signature', detail: '10000' });
  });

  it('maps signed business errors, system errors and unsigned gateway refusals', async () => {
    const biz =
      '{"code":"40004","msg":"Business Failed","sub_code":"PAYEE_NOT_EXIST","sub_msg":"收款账号不存在"}';
    const rejected = await client(() =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: signedBody('alipay_fund_trans_uni_transfer_response', biz),
      }),
    ).transfer({
      outBizNo: 'W3',
      amountFen: 10,
      payeeLogonId: 'a@example.test',
      payeeName: '张三',
      orderTitle: 't',
    });
    expect(rejected).toMatchObject({
      kind: 'rejected',
      code: 'PAYEE_NOT_EXIST',
      message: '收款账号不存在',
    });

    const sys =
      '{"code":"40004","msg":"Business Failed","sub_code":"SYSTEM_ERROR","sub_msg":"系统繁忙"}';
    const unknown = await client(() =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: signedBody('alipay_fund_trans_uni_transfer_response', sys),
      }),
    ).transfer({
      outBizNo: 'W4',
      amountFen: 10,
      payeeLogonId: 'a@example.test',
      payeeName: '张三',
      orderTitle: 't',
    });
    expect(unknown).toEqual({ kind: 'unknown', reason: 'http_5xx', detail: 'SYSTEM_ERROR' });

    const gateway =
      '{"error_response":{"code":"40002","msg":"Invalid Arguments","sub_code":"isv.invalid-signature","sub_msg":"验签出错"}}';
    const refused = await client(() =>
      Promise.resolve({ status: 200, headers: {}, body: gateway }),
    ).tradeQuery('P1');
    expect(refused).toMatchObject({ kind: 'rejected', code: 'isv.invalid-signature' });

    const timeout = await client(() =>
      Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })),
    ).tradeClose('P1');
    expect(timeout).toEqual({ kind: 'unknown', reason: 'timeout', detail: 'TimeoutError' });
  });

  it('verifies notifications over every field except sign and sign_type', () => {
    const c = client(() => Promise.reject(new Error('unused')));
    const form: Record<string, string> = {
      app_id: '2021000000000001',
      out_trade_no: 'P1',
      total_amount: '0.01',
      trade_status: 'TRADE_SUCCESS',
      notify_id: 'n1',
    };
    const signed = {
      ...form,
      sign_type: 'RSA2',
      sign: rsa2Sign(alipaySignContent(form), alipay.privateKey),
    };
    expect(c.verifyNotification(signed)).toBe(true);
    expect(c.verifyNotification({ ...signed, total_amount: '0.02' })).toBe(false);
    expect(c.verifyNotification(form)).toBe(false);
  });
});
