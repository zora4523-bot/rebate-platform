// B2-15k 微信下单与调起（claude-independent，SPEC_REF deb521c2）：08 BR-PAY-03（签名只在服务端、时限传给渠道、
// 下单失败或超时 50306 由未知结果得出）；任务书 9.2、9.6；r3 必须改 ④、第 1 轮第 4、6 项。
// 出处：docs-mirror/wechat-pay/pages/4013070347.txt（下单）、4012365340.txt（调起签名）、4012365342.txt 与
// 4013053249.txt（签名验签）。未实测（BR-PAY-09）。
import { createVerify } from 'node:crypto';
import { expect, it } from 'vitest';
import type { WechatLaunch } from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
import { NOTIFY_ROUTES } from '../../../../apps/api/src/modules/payment/application/notify-routes.ts';
import {
  APIV3_KEY,
  MCHID,
  MERCHANT,
  NOTIFY_BASE,
  NOW_S,
  ORDER,
  OUT,
  WX_APPID,
  expectUnknown,
  expectWxSigned,
  headerOf,
  okOf,
  textOf,
  wechatChannel,
  wxAnswer,
  wxEnvelopeFaults,
  type Json,
} from './kit.ts';

const OK_BODY = JSON.stringify({ prepay_id: 'wx-prepay-1' });

it('[AC-B2-15k#101] 下单请求：POST /v3/pay/transactions/app，APIv3 签名串覆盖方法、路径、注入时钟的时间戳、随机串、正文，带配置的公钥 ID', async () => {
  const h = wechatChannel(() => wxAnswer(200, OK_BODY));
  okOf(await h.channel.createOrder(ORDER));
  expect(h.calls).toHaveLength(1);
  const request = h.calls[0]!;
  expect(request.method).toBe('POST');
  expect(request.url).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/app');
  expect(headerOf(request, 'accept')).toContain('application/json');
  expect(headerOf(request, 'content-type')).toContain('application/json');
  expectWxSigned(request);
});

it('[AC-B2-15k#102] 下单正文只含文档字段：appid、mchid、description、out_trade_no、time_expire、notify_url、amount{total, currency}', async () => {
  const h = wechatChannel(() => wxAnswer(200, OK_BODY));
  okOf(await h.channel.createOrder(ORDER));
  const body = JSON.parse(h.calls[0]!.body ?? '{}') as Json;
  expect(body).toEqual({
    appid: WX_APPID,
    mchid: MCHID,
    description: ORDER.description,
    out_trade_no: OUT,
    time_expire: expect.any(String) as unknown,
    notify_url: `${NOTIFY_BASE}${NOTIFY_ROUTES.wechat_pay}`,
    amount: { total: 100, currency: 'CNY' },
  });
});

it('[AC-B2-15k#103] time_expire 是 RFC 3339、精确到秒，不晚于 expireAt（BR-PAY-03：支付截止时间不得晚于 expire_at）', async () => {
  const h = wechatChannel(() => wxAnswer(200, OK_BODY));
  okOf(await h.channel.createOrder(ORDER));
  const body = JSON.parse(h.calls[0]!.body ?? '{}') as { time_expire: string };
  expect(body.time_expire).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/);
  const instant = Date.parse(body.time_expire);
  expect(instant).toBeLessThanOrEqual(ORDER.expireAt.getTime());
  expect(ORDER.expireAt.getTime() - instant).toBeLessThan(1000);
});

it('[AC-B2-15k#104] notify_url 是 new URL(notifyUrl, PAY_NOTIFY_BASE_URL)，只取基址的源，路径来自 notify-routes', async () => {
  const h = wechatChannel(() => wxAnswer(200, OK_BODY));
  okOf(await h.channel.createOrder({ ...ORDER, notifyUrl: NOTIFY_ROUTES.wechat_pay }));
  const body = JSON.parse(h.calls[0]!.body ?? '{}') as { notify_url: string };
  expect(body.notify_url).toBe('https://pay.example.test/notify/pay/wechat');
});

it('[AC-B2-15k#105] 调起参数：prepay_id 原样、package 固定 Sign=WXPay、用商户私钥对 appId\\n时间戳\\n随机串\\nprepay_id\\n 做 RSA-SHA256，时间戳取注入时钟', async () => {
  const h = wechatChannel(() => wxAnswer(200, OK_BODY));
  const result = okOf(await h.channel.createOrder(ORDER));
  expect(result.channelRef).toBe('wx-prepay-1');
  const launch = result.launch as WechatLaunch;
  expect(launch.appid).toBe(WX_APPID);
  expect(launch.partnerid).toBe(MCHID);
  expect(launch.prepayid).toBe('wx-prepay-1');
  expect(launch.package).toBe('Sign=WXPay');
  expect(launch.timestamp).toBe(String(NOW_S));
  expect(launch.noncestr).not.toBe('');
  const message = `${WX_APPID}\n${launch.timestamp}\n${launch.noncestr}\n${launch.prepayid}\n`;
  expect(
    createVerify('RSA-SHA256')
      .update(message, 'utf8')
      .verify(MERCHANT.publicKey, launch.sign, 'base64'),
  ).toBe(true);
});

it('[AC-B2-15k#106] 商户私钥与 APIv3 密钥不进调起参数（BR-PAY-03：不得由服务端下发）；每次调起随机串不同', async () => {
  const h = wechatChannel(() => wxAnswer(200, OK_BODY));
  const first = okOf(await h.channel.createOrder(ORDER));
  const second = okOf(await h.channel.createOrder(ORDER));
  const text = textOf(first);
  expect(text).not.toContain('PRIVATE KEY');
  expect(text).not.toContain(APIV3_KEY);
  expect((first.launch as WechatLaunch).noncestr).not.toBe(
    (second.launch as WechatLaunch).noncestr,
  );
  expect(headerOf(h.calls[0]!, 'authorization')).not.toBe(headerOf(h.calls[1]!, 'authorization'));
});

it.each([
  [1n, 1],
  [99n, 99],
  [100n, 100],
  [101n, 101],
  [2147483647n, 2147483647],
  [2147483648n, 2147483648],
  [2147483649n, 2147483649],
])(
  '[AC-B2-15k#107] 金额边界 %s 分：正文 amount.total 是同值的整数，不经浮点',
  async (fen, total) => {
    const h = wechatChannel(() => wxAnswer(200, OK_BODY));
    okOf(await h.channel.createOrder({ ...ORDER, amountFen: fen }));
    expect(h.calls[0]!.body ?? '').toContain(`"total":${String(total)}`);
  },
);

it.each([
  ['0 分', 0n],
  ['负数', -1n],
  ['超过 JSON 安全整数', 2n ** 53n],
])('[AC-B2-15k#108] 非法下单金额（%s）：unknown，不抛异常、不发请求', async (_name, fen) => {
  const h = wechatChannel(() => wxAnswer(200, OK_BODY));
  expectUnknown(await h.channel.createOrder({ ...ORDER, amountFen: fen }));
  expect(h.calls).toHaveLength(0);
});

it.each(wxEnvelopeFaults(OK_BODY))(
  '[AC-B2-15k#109] 下单应答不可信（%s）：unknown',
  async (_name, answer) => {
    const h = wechatChannel(() => answer);
    expectUnknown(await h.channel.createOrder(ORDER));
  },
);

const BAD_ORDER_BODIES: [string, Json][] = [
  ['缺 prepay_id', {}],
  ['prepay_id 是空串', { prepay_id: '' }],
  ['prepay_id 是数字', { prepay_id: 42 }],
  ['prepay_id 是对象', { prepay_id: { value: 'wx' } }],
  ['回显的单号不符', { prepay_id: 'wx-prepay-1', out_trade_no: 'P-OTHER' }],
  ['回显的商户号不符', { prepay_id: 'wx-prepay-1', mchid: '1900000000' }],
  ['回显的应用不符', { prepay_id: 'wx-prepay-1', appid: 'wx-other' }],
  ['成功应答带错误码', { prepay_id: 'wx-prepay-1', code: 'SYSTEM_ERROR' }],
];

it.each(BAD_ORDER_BODIES)(
  '[AC-B2-15k#110] 下单 200 验签通过但内容不对（%s）：unknown',
  async (_name, body) => {
    const h = wechatChannel(() => wxAnswer(200, body));
    expectUnknown(await h.channel.createOrder(ORDER));
  },
);

it.each([
  [403, 'OUT_TRADE_NO_USED'],
  [403, 'NO_AUTH'],
  [400, 'APPID_MCHID_NOT_MATCH'],
  [400, 'MCH_NOT_EXISTS'],
  [400, 'PARAM_ERROR'],
  [401, 'SIGN_ERROR'],
  [429, 'FREQUENCY_LIMITED'],
  [500, 'SYSTEM_ERROR'],
])(
  '[AC-B2-15k#111] 验过签的业务错误 %s %s：只有 unknown，没有 failed / rejected',
  async (status, code) => {
    const h = wechatChannel(() => wxAnswer(status, { code, message: 'message' }));
    expectUnknown(await h.channel.createOrder(ORDER));
  },
);

it('[AC-B2-15k#112] transport 抛异常（超时等）：unknown，不抛；只发一次，不自动重发', async () => {
  const h = wechatChannel(() => {
    throw Object.assign(new Error('boom'), { name: 'TimeoutError' });
  });
  expectUnknown(await h.channel.createOrder(ORDER));
  expect(h.calls).toHaveLength(1);
});

it.each([
  ['早 299 秒', NOW_S - 299],
  ['晚 299 秒', NOW_S + 299],
])('[AC-B2-15k#113] 应答时间窗边界：%s 仍接受', async (_name, at) => {
  const h = wechatChannel(() => wxAnswer(200, OK_BODY, { at }));
  okOf(await h.channel.createOrder(ORDER));
});
