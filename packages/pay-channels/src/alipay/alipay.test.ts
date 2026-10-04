import { createVerify, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { describeResult, type HttpRequest, type Transport } from '../transport.ts';
import { AlipayClient, topLevelMembers } from './client.ts';
import {
  alipaySignContent,
  alipayTimestamp,
  certSn,
  decodeDerString,
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

// Self-signed test certificates (no real identity). Expected serial numbers were computed
// independently: md5(issuer attributes reversed, raw values + decimal serial from openssl).
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
// Issuer organisation is "Example, Inc." — a comma that display formats escape.
const SPECIAL_CERT = `-----BEGIN CERTIFICATE-----
MIIDZTCCAk2gAwIBAgIUEh2DjjPU2qcR9kYung44sZXen/4wDQYJKoZIhvcNAQEL
BQAwQjELMAkGA1UEBhMCQ04xFjAUBgNVBAoMDUV4YW1wbGUsIEluYy4xGzAZBgNV
BAMMEmNvdWxpLXRlc3Qtc3BlY2lhbDAeFw0yNjEwMDQxMDA5NDFaFw0zNjEwMDEx
MDA5NDFaMEIxCzAJBgNVBAYTAkNOMRYwFAYDVQQKDA1FeGFtcGxlLCBJbmMuMRsw
GQYDVQQDDBJjb3VsaS10ZXN0LXNwZWNpYWwwggEiMA0GCSqGSIb3DQEBAQUAA4IB
DwAwggEKAoIBAQCR/tJXrNe6NdaP+0JOhEN45F9btJaUCQ2De/W9Lk1trG3XlwMQ
ro51oXrrK/Y2ZB9z/dqO9q3oga82mIZNF8q1lpkHCBhxwB4GKWd7192mXLJ3RXxx
5cQL7WiEwwAcM4cWjzCwP8ChiSY3B1dkTtYyvSiClzkXGpUTO/rjA3ROZGVdaHPD
+sNZ45/XJXs1R780wEaJra5f3Uu81OLSIgD9egViTU9Xs4DtSCmYjjWAAkL8wjPw
empXnIzd4OYXHQfZn5Un37PPAmit+tfsjPiTkXqRYPmO11CdCt8q+VxkFtLWecT+
YJ4W1228EsLhSosJX26omJZqlXVv0Ggi6+krAgMBAAGjUzBRMB0GA1UdDgQWBBSF
ivu3xoK/UbzfH0Foxd8LCPutwTAfBgNVHSMEGDAWgBSFivu3xoK/UbzfH0Foxd8L
CPutwTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQCPei76RVtO
KOoTwDg3FEYcZbH4bdRWJr/5K53HuGCCqI+3XZunMdsE78jr4LoDk/UF2QNLH6ps
fJ+PXd5Usm2oa1SixFTokZPYtcwcRtB+8eax3zximhK52ASeAmqUHj/NNIZvtN2h
LtX9ysTNqFrRDQ/MxKIjRgdAsKadZbN2ln5wL++2Tdt8ZJPRp94GROtjKSxSI35Y
VqZIXqiFpzD+NU62RQ9qaUJUHpcKRu+ZiE1iwRU85LWZZ9/254ZDjdNiPwgiePS5
uQXOBdvo9kCsNBsOIfSD5dAFXFLJF3Ae+8sDAtapn4xZe7lnC61u/K7OLmSgAGS6
M4ZRUvUp3vWe
-----END CERTIFICATE-----`;
const SPECIAL_CERT_SN = '510d9c8c786a04ecc8b21150648970a1';

const ALIPAY_SN = 'alipay-cert-sn';
const TRANSFER = 'alipay_fund_trans_uni_transfer_response';
const transferInput = {
  outBizNo: 'W1',
  amountFen: 10,
  payeeLogonId: 'a@example.test',
  payeeName: '张三',
  orderTitle: 't',
};

function client(transport: Transport): AlipayClient {
  return new AlipayClient({
    appId: '2021000000000001',
    privateKeyPem: app.privateKey,
    appCertSn: 'app-sn',
    alipayRootCertSn: 'root-sn',
    alipayPublicKeyPem: alipay.publicKey,
    alipayCertSn: ALIPAY_SN,
    transport,
    now: () => Date.UTC(2026, 9, 4, 8, 30, 5),
  });
}

const sign = (node: string): string => rsa2Sign(node, alipay.privateKey);

function body(
  nodeKey: string,
  node: string,
  opts: { sign?: string; sn?: string | null } = {},
): string {
  const sn = opts.sn === null ? '' : `"alipay_cert_sn":"${opts.sn ?? ALIPAY_SN}",`;
  return `{"${nodeKey}":${node},${sn}"sign":"${opts.sign ?? sign(node)}"}`;
}

const answer =
  (text: string): Transport =>
  () =>
    Promise.resolve({ status: 200, headers: {}, body: text });

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

  it('computes certificate serial numbers from the raw issuer attributes', () => {
    expect(certSn(TEST_CERT)).toBe(TEST_CERT_SN);
    expect(certSn(SPECIAL_CERT)).toBe(SPECIAL_CERT_SN);
    expect(rootCertSn(`${TEST_CERT}\n${SPECIAL_CERT}`)).toBe(`${TEST_CERT_SN}_${SPECIAL_CERT_SN}`);
    expect(publicKeyFromCert(TEST_CERT)).toContain('BEGIN PUBLIC KEY');
  });

  it('decodes ASN.1 strings by type and fails closed on the rest', () => {
    expect(decodeDerString(0x0c, Buffer.from('Café', 'utf8'))).toBe('Café');
    expect(decodeDerString(0x0c, Buffer.from('\uFEFFTest', 'utf8'))).toBe('\uFEFFTest');
    expect(decodeDerString(0x14, Buffer.from([0x43, 0x61, 0x66, 0xe9]))).toBe('Café');
    expect(decodeDerString(0x1c, Buffer.from([0, 0, 0, 0x41]))).toBe('A');
    expect(decodeDerString(0x1e, Buffer.from([0x4e, 0x2d]))).toBe('中');
    expect(() => decodeDerString(0x13, Buffer.from([0xe9]))).toThrow();
    expect(() => decodeDerString(0x0c, Buffer.from([0xff]))).toThrow();
    expect(() => decodeDerString(0x1e, Buffer.from([0x4e]))).toThrow();
    expect(() => decodeDerString(0x12, Buffer.from('1'))).toThrow();
  });

  it('refuses a truncated or polluted root bundle', () => {
    const truncated = `${TEST_CERT}\n-----BEGIN CERTIFICATE-----\nMIIB`;
    expect(() => rootCertSn(truncated)).toThrow();
    expect(() => rootCertSn(`${TEST_CERT}\nstray text`)).toThrow();
    expect(() => rootCertSn('')).toThrow();
  });

  it('formats timestamps in +08:00', () => {
    expect(alipayTimestamp(Date.UTC(2026, 9, 4, 16, 0, 0))).toBe('2026-10-05 00:00:00');
  });

  it('splits a response into top-level members byte for byte', () => {
    const raw =
      ' { "x_response" : {"code":"10000","msg":"a}\\"b","x_response":{"k":1}} , "n":null,"sign":"s" } ';
    expect(topLevelMembers(raw)).toEqual([
      { key: 'x_response', raw: '{"code":"10000","msg":"a}\\"b","x_response":{"k":1}}' },
      { key: 'n', raw: 'null' },
      { key: 'sign', raw: '"s"' },
    ]);
    expect(topLevelMembers('{"a":1,"a":2}')).toHaveLength(2);
    expect(topLevelMembers('[1]')).toBeUndefined();
    expect(topLevelMembers('{"a":1} trailing')).toBeUndefined();
    expect(topLevelMembers('{"a":{"b":1}')).toBeUndefined();
  });
});

describe('alipay client', () => {
  const QUERY = 'alipay_fund_trans_common_query_response';
  const okNode = (no = 'W1', extra = ''): string =>
    `{"code":"10000","msg":"Success","out_biz_no":"${no}","order_id":"2026","status":"SUCCESS"${extra}}`;
  const run = (node: string) => client(answer(body(TRANSFER, node))).transfer(transferInput);

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
    expect(
      createVerify('RSA-SHA256')
        .update(alipaySignContent(params))
        .verify(app.publicKey, params['sign'] ?? '', 'base64'),
    ).toBe(true);
  });

  it('sends public parameters in the query string and the business payload in the body', async () => {
    const seen: HttpRequest[] = [];
    const c = client((req) => {
      seen.push(req);
      return Promise.resolve({ status: 200, headers: {}, body: body(QUERY, okNode()) });
    });
    expect(await c.transferQuery('W1')).toMatchObject({ kind: 'ok', data: { status: 'SUCCESS' } });
    const url = new URL(seen[0]?.url ?? '');
    const query = Object.fromEntries(url.searchParams);
    const form = Object.fromEntries(new URLSearchParams(seen[0]?.body ?? ''));
    expect(query['method']).toBe('alipay.fund.trans.common.query');
    expect(query['charset']).toBe('utf-8');
    expect(query['biz_content']).toBeUndefined();
    expect(Object.keys(form)).toEqual(['biz_content']);
    expect(JSON.parse(form['biz_content'] ?? '{}')).toEqual({
      out_biz_no: 'W1',
      product_code: 'TRANS_ACCOUNT_NO_PWD',
      biz_scene: 'DIRECT_TRANSFER',
    });
    // the signature covers query and body together
    expect(
      createVerify('RSA-SHA256')
        .update(alipaySignContent({ ...query, ...form }))
        .verify(app.publicKey, query['sign'] ?? '', 'base64'),
    ).toBe(true);
  });

  it('keeps an existing query string on a custom gateway', async () => {
    const seen: HttpRequest[] = [];
    const c = new AlipayClient({
      appId: '2021000000000001',
      privateKeyPem: app.privateKey,
      appCertSn: 'app-sn',
      alipayRootCertSn: 'root-sn',
      alipayPublicKeyPem: alipay.publicKey,
      alipayCertSn: ALIPAY_SN,
      gateway: 'https://gw.example.test/gateway.do?route=test',
      transport: (req) => {
        seen.push(req);
        return Promise.resolve({ status: 200, headers: {}, body: body(QUERY, okNode()) });
      },
    });
    await c.transferQuery('W1');
    const url = new URL(seen[0]?.url ?? '');
    expect(url.searchParams.get('route')).toBe('test');
    expect(url.searchParams.get('app_id')).toBe('2021000000000001');
  });

  it('carries the transfer scene fields', async () => {
    const seen: HttpRequest[] = [];
    const c = client((req) => {
      seen.push(req);
      return Promise.resolve({ status: 200, headers: {}, body: body(TRANSFER, okNode()) });
    });
    const r = await c.transfer({
      ...transferInput,
      transferSceneName: '佣金报酬',
      sceneReportInfos: [{ infoType: '佣金报酬说明', infoContent: '10 月推广报酬' }],
    });
    expect(r.kind).toBe('ok');
    const form = Object.fromEntries(new URLSearchParams(seen[0]?.body ?? ''));
    expect(JSON.parse(form['biz_content'] ?? '{}')).toMatchObject({
      trans_amount: '0.10',
      transfer_scene_name: '佣金报酬',
      transfer_scene_report_infos: [{ info_type: '佣金报酬说明', info_content: '10 月推广报酬' }],
    });
  });

  it('never trusts an answer that is unsigned, wrongly signed or signed under another certificate', async () => {
    const fail =
      '{"code":"40004","msg":"Business Failed","sub_code":"PAYEE_NOT_EXIST","sub_msg":"x"}';
    const cases: [string, string][] = [
      ['forged signature', body(TRANSFER, okNode(), { sign: rsa2Sign(okNode(), app.privateKey) })],
      ['other certificate', body(TRANSFER, okNode(), { sn: 'someone-else' })],
      ['no certificate serial', body(TRANSFER, okNode(), { sn: null })],
      ['unsigned success', `{"${TRANSFER}":${okNode()}}`],
      ['unsigned business failure', `{"${TRANSFER}":${fail}}`],
      ['unsigned gateway code', '{"error_response":{"code":"40002","sub_code":"PAYEE_NOT_EXIST"}}'],
    ];
    for (const [name, text] of cases) {
      expect(await client(answer(text)).transfer(transferInput), name).toMatchObject({
        kind: 'unknown',
        reason: 'bad_signature',
      });
    }
  });

  it('is not fooled by nested, duplicated or misplaced response nodes', async () => {
    const old = okNode();
    const live = `{"code":"20000","msg":"Service Currently Unavailable","nested":{"${TRANSFER}":${old}}}`;
    expect(
      await client(answer(body(TRANSFER, live, { sign: sign(old) }))).transfer(transferInput),
    ).toMatchObject({
      kind: 'unknown',
      reason: 'bad_signature',
    });
    const tail = `"alipay_cert_sn":"${ALIPAY_SN}","sign":"${sign(old)}"}`;
    for (const text of [
      `{"${TRANSFER}":${old},"${TRANSFER}":{"code":"20000"},${tail}`,
      `{"${TRANSFER}":null,"other":${old},${tail}`,
      `{"${TRANSFER}":${old},"error_response":{"code":"20000"},${tail}`,
      body('error_response', old),
    ]) {
      expect(await client(answer(text)).transfer(transferInput)).toMatchObject({ kind: 'unknown' });
    }
  });

  it('refuses answers whose surrounding JSON is invalid, even with a valid signed node', async () => {
    for (const junk of ['01', 'truefalse', '[}', '{"x":1,}', '"bad\\q"']) {
      const text = `{"${TRANSFER}":${okNode()},"junk":${junk},"alipay_cert_sn":"${ALIPAY_SN}","sign":"${sign(okNode())}"}`;
      expect(await client(answer(text)).transfer(transferInput), junk).toMatchObject({
        kind: 'unknown',
        reason: 'bad_body',
      });
    }
  });

  it('accepts verified answers with whitespace around tokens', async () => {
    const node = okNode().replace('SUCCESS"', 'DEALING"').replace('"Success"', '"Success"');
    const dealing =
      '{"code":"10000","msg":"Success","out_biz_no":"W1","order_id":"2026","status":"DEALING"}';
    const spaced = ` { "${TRANSFER}" : ${dealing} , "alipay_cert_sn" : "${ALIPAY_SN}" , "sign" : "${sign(dealing)}" } `;
    expect(node).toContain('W1');
    expect(await client(answer(spaced)).transfer(transferInput)).toMatchObject({
      kind: 'ok',
      data: { status: 'DEALING' },
    });
  });

  it('never reports an error answer as a failure, whatever the code combination', async () => {
    for (const [code, sub] of [
      ['40004', 'PAYEE_NOT_EXIST'],
      ['40004', 'SYSTEM_ERROR'],
      ['40004', 'TRANS_ORDER_DEALING'],
      ['40004', 'A_SUB_CODE_NOBODY_HAS_SEEN'],
      ['20000', 'PAYEE_NOT_EXIST'],
      ['99999', 'BALANCE_IS_NOT_ENOUGH'],
      ['40005', 'INVALID_PARAMETER'],
    ] as const) {
      const node = `{"code":"${code}","msg":"m","sub_code":"${sub}","sub_msg":"账号 a@example.test","out_biz_no":"W_OLD"}`;
      expect(await run(node), `${code}/${sub}`).toEqual({
        kind: 'unknown',
        reason: 'channel_error',
        detail: code,
        code: sub,
        verified: true,
      });
    }
    expect(await run('{"code":"20000","msg":"Service Currently Unavailable"}')).toMatchObject({
      kind: 'unknown',
      reason: 'channel_error',
      code: '20000',
    });
    const notFound = '{"code":"40004","msg":"Business Failed","sub_code":"ORDER_NOT_EXIST"}';
    expect(await client(answer(body(QUERY, notFound))).transferQuery('W9')).toMatchObject({
      kind: 'unknown',
      reason: 'channel_error',
      code: 'ORDER_NOT_EXIST',
      verified: true,
    });
  });

  it('treats malformed or contradictory verified answers as unknown', async () => {
    const q = (node: string) => client(answer(body(QUERY, node))).transferQuery('W1');
    expect(await run('{"msg":"no code"}')).toMatchObject({ kind: 'unknown', reason: 'bad_body' });
    expect(await run(okNode('W1', ',"sub_code":"SYSTEM_ERROR"'))).toMatchObject({
      kind: 'unknown',
      reason: 'bad_body',
    });
    expect(await run(okNode('W1', ',"sub_code":{"error":"SYSTEM_ERROR"}'))).toMatchObject({
      kind: 'unknown',
      detail: 'sub_code is not a string',
    });
    expect(await run('{"code":"10000","msg":"Success"}')).toMatchObject({
      kind: 'unknown',
      detail: 'missing out_biz_no',
    });
    expect(
      await q('{"code":"10000","msg":"Success","out_biz_no":"W1","status":"SUCCESS"}'),
    ).toMatchObject({
      kind: 'unknown',
      detail: 'missing order_id',
    });
    expect(
      await q(
        '{"code":"10000","msg":"Success","out_biz_no":"W1","order_id":42,"status":"SUCCESS"}',
      ),
    ).toMatchObject({
      kind: 'unknown',
      detail: 'missing order_id',
    });
    expect(await q(okNode('W1', ',"trans_amount":"NOT_MONEY"'))).toMatchObject({
      kind: 'unknown',
      detail: 'invalid trans_amount',
    });
    expect(await q(okNode('W1').replace('"SUCCESS"', '"A_NEW_STATUS"'))).toMatchObject({
      kind: 'unknown',
      detail: 'unexpected status',
    });
    expect(await q(okNode('W1', ',"trans_amount":"32.00"'))).toMatchObject({ kind: 'ok' });
  });

  it('does not accept a valid answer that belongs to another order or another interface', async () => {
    expect(await client(answer(body(QUERY, okNode('W_OLD')))).transferQuery('W_NEW')).toMatchObject(
      {
        kind: 'unknown',
        detail: 'mismatched out_biz_no',
      },
    );
    const trade = (no: string): string =>
      `{"code":"10000","msg":"Success","out_trade_no":"${no}","trade_no":"t","trade_status":"TRADE_SUCCESS","total_amount":"0.01"}`;
    expect(
      await client(answer(body('alipay_trade_query_response', trade('P_OLD')))).tradeQuery('P_NEW'),
    ).toMatchObject({
      kind: 'unknown',
      detail: 'mismatched out_trade_no',
    });
    // a signed query answer re-labelled as a close answer
    expect(
      await client(answer(body('alipay_trade_close_response', trade('P1')))).tradeClose('P1'),
    ).toMatchObject({
      kind: 'unknown',
      detail: 'unexpected field',
    });
    const closed = '{"code":"10000","msg":"Success","out_trade_no":"P1","trade_no":"t"}';
    expect(
      await client(answer(body('alipay_trade_close_response', closed))).tradeClose('P1'),
    ).toMatchObject({ kind: 'ok' });
  });

  it('binds refund queries to the refund request when refund fields are present', async () => {
    const R = 'alipay_trade_fastpay_refund_query_response';
    const q = (node: string) => client(answer(body(R, node))).refundQuery('P1', 'R_NEW');
    const base = '"code":"10000","msg":"Success"';
    expect(await q(`{${base}}`)).toMatchObject({ kind: 'ok' });
    expect(
      await q(`{${base},"refund_status":"REFUND_SUCCESS","refund_amount":"0.10"}`),
    ).toMatchObject({
      kind: 'unknown',
      detail: 'missing out_trade_no',
    });
    expect(
      await q(
        `{${base},"out_trade_no":"P1","out_request_no":"R_OLD","refund_status":"REFUND_SUCCESS","refund_amount":"0.10"}`,
      ),
    ).toMatchObject({ kind: 'unknown', detail: 'mismatched out_request_no' });
    expect(
      await q(
        `{${base},"out_trade_no":"P1","out_request_no":"R_NEW","refund_status":{"x":1},"refund_amount":"0.10"}`,
      ),
    ).toMatchObject({ kind: 'unknown', detail: 'invalid refund_status' });
    expect(
      await q(
        `{${base},"out_trade_no":"P1","out_request_no":"R_NEW","refund_status":"REFUND_SUCCESS","refund_amount":"-1"}`,
      ),
    ).toMatchObject({ kind: 'unknown', detail: 'invalid refund_amount' });
    expect(
      await q(
        `{${base},"out_trade_no":"P1","out_request_no":"R_NEW","refund_status":"REFUND_SUCCESS","refund_amount":"0.10"}`,
      ),
    ).toMatchObject({ kind: 'ok' });
  });

  it('maps transport failures and non-200 answers to unknown, keeping a readable hint', async () => {
    const timeout = await client(() =>
      Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })),
    ).tradeClose('P1');
    expect(timeout).toEqual({ kind: 'unknown', reason: 'timeout', detail: 'timed out' });
    const five = '{"alipay_trade_query_response":{"code":"20000","sub_code":"SYSTEM_ERROR"}}';
    expect(
      await client(() => Promise.resolve({ status: 500, headers: {}, body: five })).tradeQuery(
        'P1',
      ),
    ).toEqual({
      kind: 'unknown',
      reason: 'http_5xx',
      detail: '500',
      code: 'SYSTEM_ERROR',
    });
    expect(
      await client(() => Promise.resolve({ status: 302, headers: {}, body: '' })).tradeQuery('P1'),
    ).toMatchObject({ kind: 'unknown', reason: 'bad_body' });
  });

  it('describes results with known constants only', async () => {
    const node =
      '{"code":"40004","msg":"Business Failed","sub_code":"PAYEE_NOT_EXIST","sub_msg":"账号 a@example.test 不存在"}';
    expect(describeResult(await run(node))).toBe(
      'unknown reason=channel_error detail=40004 code=PAYEE_NOT_EXIST verified',
    );
    expect(describeResult({ kind: 'ok', data: { payee: 'secret' } })).toBe('ok');
    for (const code of [
      '13800138000',
      'oSyntheticPrivateOpenid123',
      'account=x@example.test\nok id=FAKE',
    ]) {
      expect(
        describeResult({
          kind: 'unknown',
          reason: 'bad_signature',
          detail: '400 bad_signature',
          code,
        }),
      ).toBe('unknown reason=bad_signature detail=400 bad_signature code=<other>');
    }
    expect(
      describeResult({
        kind: 'unknown',
        reason: 'transport',
        detail: 'Customer 13800138000\nx@example.test',
      }),
    ).toBe('unknown reason=transport detail=Customer #?x?example.test');
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
