// B2-15k 日志（claude-independent，SPEC_REF deb521c2）：08 BR-PAY-03（调起参数不写日志）、BR-PAY-08 ④；任务书 9.10：摘要
// 只输出已知常量，未知错误码用固定占位，异常名称映射到固定类别；私钥、APIv3 密钥、调起参数、通知原文、应答正文、用户标识
// 都不进日志。r3 必须改 ⑤（未验签应答的 code、自定义 transport 的 Error.name 原样进摘要）与建议改 ③（非 200 的已知诊断码）。
import { expect, it } from 'vitest';
import type {
  AlipayLaunch,
  WechatLaunch,
} from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
import {
  ALIPAY_APP,
  ALIPAY_ORDER,
  APIV3_KEY,
  MERCHANT,
  OPENID,
  ORDER,
  OUT,
  QUERY_NODE,
  aliAnswer,
  aliBody,
  aliError,
  aliNotification,
  aliPayFields,
  aliTrade,
  alipayChannel,
  okOf,
  rawAnswer,
  wechatChannel,
  wxAnswer,
  wxPayNotification,
  wxTrade,
} from './kit.ts';

const PHONE = '13800138000';
const LEAKY_NAME = `Customer ${PHONE} synthetic.example.test`;

function pemBody(pem: string): string {
  return pem.split('\n').slice(1, 4).join('');
}

function expectClean(logs: readonly string[], ...secrets: readonly string[]): void {
  const text = logs.join('\n');
  for (const secret of [
    pemBody(MERCHANT.privateKey),
    pemBody(ALIPAY_APP.privateKey),
    APIV3_KEY,
    OPENID,
    PHONE,
    'synthetic.example.test',
    ...secrets,
  ]) {
    expect(text).not.toContain(secret);
  }
}

it('[AC-B2-15k#1601] 微信下单成功：私钥、APIv3 密钥、调起参数都不进日志', async () => {
  const h = wechatChannel(() => wxAnswer(200, { prepay_id: 'wx-prepay-secret' }));
  const launch = okOf(await h.channel.createOrder(ORDER)).launch as WechatLaunch;
  expectClean(h.logs, 'wx-prepay-secret', launch.sign, launch.noncestr);
});

it('[AC-B2-15k#1602] 支付宝下单成功：orderStr 与签名都不进日志', async () => {
  const h = alipayChannel();
  const launch = okOf(await h.channel.createOrder(ALIPAY_ORDER)).launch as AlipayLaunch;
  const sign = new URLSearchParams(launch.order_str).get('sign') ?? '';
  expectClean(h.logs, launch.order_str, sign);
});

it('[AC-B2-15k#1603] 微信通知原文、解密后的用户标识不进日志（通过的和拒绝的都一样）', async () => {
  const h = wechatChannel();
  const raw = wxPayNotification();
  okOf(await h.channel.verifyNotification(raw));
  await h.channel.verifyNotification({ headers: {}, body: raw.body });
  expectClean(h.logs, raw.body, raw.headers['wechatpay-signature'] ?? '');
});

it('[AC-B2-15k#1604] 支付宝通知原文、买家信息不进日志（通过的和拒绝的都一样）', async () => {
  const h = alipayChannel();
  const raw = aliNotification(aliPayFields({ buyer_logon_id: `buyer-${PHONE}` }));
  okOf(await h.channel.verifyNotification(raw));
  await h.channel.verifyNotification({ headers: {}, body: `${raw.body}x` });
  expectClean(h.logs, raw.body);
});

it('[AC-B2-15k#1605] r3 必须改 ⑤：未验签的微信应答把手机号、用户标识放进 code：结果和日志都不带', async () => {
  for (const code of [PHONE, OPENID]) {
    const h = wechatChannel(() => ({ status: 403, headers: {}, body: JSON.stringify({ code }) }));
    const result = await h.channel.query(OUT);
    expect(result.kind).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain(code);
    expectClean(h.logs);
  }
});

it('[AC-B2-15k#1606] r3 必须改 ⑤：未验签的支付宝应答把手机号放进 code / sub_code：结果和日志都不带', async () => {
  const h = alipayChannel(() =>
    rawAnswer(`{"${QUERY_NODE}":${JSON.stringify(aliError(PHONE, OPENID))},"sign":"bm90"}`),
  );
  const result = await h.channel.query(OUT);
  expect(result.kind).toBe('unknown');
  expect(JSON.stringify(result)).not.toContain(PHONE);
  expect(JSON.stringify(result)).not.toContain(OPENID);
  expectClean(h.logs);
});

it('[AC-B2-15k#1607] 验过签的错误应答带未知错误码：固定占位，不原样输出', async () => {
  const code = `X_${PHONE}`;
  const wechat = wechatChannel(() => wxAnswer(400, { code, message: PHONE }));
  expect(JSON.stringify(await wechat.channel.query(OUT))).not.toContain(PHONE);
  expectClean(wechat.logs);
  const alipay = alipayChannel(() => aliAnswer(QUERY_NODE, aliError('40004', code)));
  expect(JSON.stringify(await alipay.channel.query(OUT))).not.toContain(PHONE);
  expectClean(alipay.logs);
});

it('[AC-B2-15k#1608] r3 必须改 ⑤：transport 抛的异常名称和消息带个人信息：映射到固定类别，结果和日志都不带', async () => {
  const leaky = (): never => {
    const error = new Error(`connect failed for ${PHONE} synthetic.example.test`);
    error.name = LEAKY_NAME;
    throw error;
  };
  const wechat = wechatChannel(leaky);
  const wxResult = await wechat.channel.query(OUT);
  expect(wxResult.kind).toBe('unknown');
  expect(JSON.stringify(wxResult)).not.toContain(PHONE);
  expectClean(wechat.logs);
  const alipay = alipayChannel(leaky);
  const aliResult = await alipay.channel.query(OUT);
  expect(aliResult.kind).toBe('unknown');
  expect(JSON.stringify(aliResult)).not.toContain(PHONE);
  expectClean(alipay.logs);
});

it('[AC-B2-15k#1609] 应答正文不进日志：查单成功、验签失败都一样', async () => {
  const body = JSON.stringify(wxTrade());
  const ok = wechatChannel(() => wxAnswer(200, body));
  okOf(await ok.channel.query(OUT));
  expectClean(ok.logs, body);
  const bad = wechatChannel(() => wxAnswer(200, body, { signature: 'bm90LWEtc2lnbmF0dXJl' }));
  await bad.channel.query(OUT);
  expectClean(bad.logs, body);

  const node = aliBody(QUERY_NODE, aliTrade());
  const alipay = alipayChannel(() => rawAnswer(node));
  okOf(await alipay.channel.query(OUT));
  expectClean(alipay.logs, node);
});

it('[AC-B2-15k#1610] r3 建议改 ③：支付宝 HTTP 500 里的已知诊断码（未验证）可读：unknown，诊断码出现在 reason 或日志里', async () => {
  const h = alipayChannel(() =>
    rawAnswer(
      `{"${QUERY_NODE}":${JSON.stringify(aliError('20000', 'ACQ.SYSTEM_ERROR'))},"sign":"bm90"}`,
      500,
    ),
  );
  const result = await h.channel.query(OUT);
  expect(result.kind).toBe('unknown');
  expect(`${JSON.stringify(result)}\n${h.logs.join('\n')}`).toMatch(/20000|ACQ\.SYSTEM_ERROR/);
});

it('[AC-B2-15k#1611] 微信 HTTP 500 里的已知诊断码可读：unknown，诊断码出现在 reason 或日志里', async () => {
  const h = wechatChannel(() => wxAnswer(500, { code: 'SYSTEM_ERROR', message: PHONE }));
  const result = await h.channel.query(OUT);
  expect(result.kind).toBe('unknown');
  expect(`${JSON.stringify(result)}\n${h.logs.join('\n')}`).toContain('SYSTEM_ERROR');
  expectClean(h.logs);
});
