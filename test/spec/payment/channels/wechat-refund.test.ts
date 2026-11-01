// B2-15k 微信退款与退款查询（claude-independent，SPEC_REF deb521c2）：08 BR-PAY-06 ④（结果只认通知或查询、逐项核对）；
// 任务书 9.2、9.4：refund 的 ok 只表示受理；回显的 out_refund_no、amount.refund、amount.total 必须与请求相等；退款
// 查询文档没有 appid / mchid，适配器用本配置值填 merchantRef / appRef。r3 必须改 ②④。
// 出处：docs-mirror/wechat-pay/pages/4013070371.txt（退款）、4013070374.txt（退款查询，错误码 763-788）。未实测。
import { expect, it } from 'vitest';
import { NOTIFY_ROUTES } from '../../../../apps/api/src/modules/payment/application/notify-routes.ts';
import {
  MCHID,
  NOTIFY_BASE,
  ORIGINAL,
  OUT,
  OUT_REFUND,
  REFUND,
  REFUND_ID,
  TRADE_NO,
  WX_APPID,
  expectUnknown,
  expectWxSigned,
  okOf,
  wechatChannel,
  without,
  wxAnswer,
  wxEnvelopeFaults,
  wxRefund,
  type Json,
} from './kit.ts';

const AMOUNT = {
  total: 100,
  refund: 10,
  payer_total: 100,
  payer_refund: 10,
  settlement_refund: 10,
  settlement_total: 100,
  discount_refund: 0,
  currency: 'CNY',
};

it('[AC-B2-15k#401] 退款请求：POST /v3/refund/domestic/refunds，带 out_trade_no、out_refund_no、amount{refund,total,currency}，退款通知地址走 notify-routes，APIv3 签名', async () => {
  const h = wechatChannel(() => wxAnswer(200, wxRefund()));
  expect(await h.channel.refund(REFUND)).toEqual({ kind: 'ok' });
  const request = h.calls[0]!;
  expect(request.method).toBe('POST');
  expect(request.url).toBe('https://api.mch.weixin.qq.com/v3/refund/domestic/refunds');
  expect(JSON.parse(request.body ?? '{}')).toMatchObject({
    out_trade_no: OUT,
    out_refund_no: OUT_REFUND,
    notify_url: `${NOTIFY_BASE}${NOTIFY_ROUTES.wechat_pay}`,
    amount: { refund: 10, total: 100, currency: 'CNY' },
  });
  expectWxSigned(request);
});

it('[AC-B2-15k#402] 异常收款没有商户单号：用渠道交易号退款，回显的 transaction_id 必须相等', async () => {
  const input = { ...REFUND, outTradeNo: null, channelTradeNo: TRADE_NO };
  const h = wechatChannel(() => wxAnswer(200, wxRefund({ out_trade_no: 'P-CHANNEL-SIDE' })));
  expect(await h.channel.refund(input)).toEqual({ kind: 'ok' });
  expect(JSON.parse(h.calls[0]!.body ?? '{}')).toMatchObject({ transaction_id: TRADE_NO });

  const other = wechatChannel(() =>
    wxAnswer(200, wxRefund({ transaction_id: '42000000000000000002' })),
  );
  expectUnknown(await other.channel.refund(input));
});

it('[AC-B2-15k#403] 原单既没有商户单号也没有渠道交易号：unknown，不发请求', async () => {
  const h = wechatChannel(() => wxAnswer(200, wxRefund()));
  expectUnknown(await h.channel.refund({ ...REFUND, outTradeNo: null, channelTradeNo: null }));
  expect(h.calls).toHaveLength(0);
});

it.each([
  [1n, 2147483649n, 1, 2147483649],
  [99n, 100n, 99, 100],
  [100n, 100n, 100, 100],
  [101n, 2147483648n, 101, 2147483648],
])(
  '[AC-B2-15k#404] 金额边界 退 %s / 总 %s：正文是同值整数，回显相等才是 ok',
  async (refundFen, totalFen, refund, total) => {
    const h = wechatChannel(() =>
      wxAnswer(200, wxRefund({ amount: { ...AMOUNT, refund, total } })),
    );
    expect(await h.channel.refund({ ...REFUND, refundFen, totalFen })).toEqual({ kind: 'ok' });
    const body = h.calls[0]!.body ?? '';
    expect(body).toContain(`"refund":${String(refund)}`);
    expect(body).toContain(`"total":${String(total)}`);
  },
);

it.each([
  ['退款金额为 0', 0n],
  ['退款金额为负', -1n],
])('[AC-B2-15k#405] %s：unknown，不发请求', async (_name, refundFen) => {
  const h = wechatChannel(() => wxAnswer(200, wxRefund()));
  expectUnknown(await h.channel.refund({ ...REFUND, refundFen }));
  expect(h.calls).toHaveLength(0);
});

it.each(wxEnvelopeFaults(JSON.stringify(wxRefund())))(
  '[AC-B2-15k#406] 退款应答不可信（%s）：unknown',
  async (_name, answer) => {
    const h = wechatChannel(() => answer);
    expectUnknown(await h.channel.refund(REFUND));
  },
);

const BAD_REFUND_ANSWERS: [string, Json][] = [
  ['out_refund_no 不符', wxRefund({ out_refund_no: 'R-OTHER' })],
  ['out_trade_no 不符', wxRefund({ out_trade_no: 'P-OTHER' })],
  ['amount.refund=999', wxRefund({ amount: { ...AMOUNT, refund: 999 } })],
  ['amount.total 不符', wxRefund({ amount: { ...AMOUNT, total: 101 } })],
  ['amount 是空对象', wxRefund({ amount: {} })],
  ['amount 是数组', wxRefund({ amount: [] })],
  ['amount.refund 为负', wxRefund({ amount: { ...AMOUNT, refund: -10 } })],
  ['amount.refund 是字符串', wxRefund({ amount: { ...AMOUNT, refund: '10' } })],
  ['amount.refund 是小数', wxRefund({ amount: { ...AMOUNT, refund: 10.5 } })],
  ['amount.currency 不是 CNY', wxRefund({ amount: { ...AMOUNT, currency: 'USD' } })],
  ['缺 amount', without(wxRefund(), 'amount')],
  ['缺 refund_id', without(wxRefund(), 'refund_id')],
  ['缺 out_refund_no', without(wxRefund(), 'out_refund_no')],
  ['缺 out_trade_no', without(wxRefund(), 'out_trade_no')],
  ['缺 transaction_id', without(wxRefund(), 'transaction_id')],
  ['缺 status', without(wxRefund(), 'status')],
  ['status 是对象', wxRefund({ status: { value: 'SUCCESS' } })],
  ['refund_id 是数字', wxRefund({ refund_id: 42 })],
  ['回显的商户号不符', wxRefund({ mchid: '1900000000' })],
  ['回显的应用不符', wxRefund({ appid: 'wx-other' })],
];

it.each(BAD_REFUND_ANSWERS)(
  '[AC-B2-15k#407] 退款 200 验签通过但与请求不符（%s）：unknown',
  async (_name, body) => {
    const h = wechatChannel(() => wxAnswer(200, body));
    expectUnknown(await h.channel.refund(REFUND));
  },
);

it.each([['SUCCESS'], ['PROCESSING']])(
  '[AC-B2-15k#408] 退款应答状态 %s：refund 的 ok 只表示受理，结果里没有退款状态',
  async (status) => {
    const h = wechatChannel(() => wxAnswer(200, wxRefund({ status })));
    expect(await h.channel.refund(REFUND)).toEqual({ kind: 'ok' });
  },
);

const BUSINESS_ERRORS: [string, number, Json][] = [
  ['NOT_ENOUGH', 403, { code: 'NOT_ENOUGH' }],
  ['INVALID_REQUEST', 400, { code: 'INVALID_REQUEST' }],
  ['PARAM_ERROR', 400, { code: 'PARAM_ERROR' }],
  ['MCH_NOT_EXISTS', 404, { code: 'MCH_NOT_EXISTS' }],
  ['RESOURCE_NOT_EXISTS', 404, { code: 'RESOURCE_NOT_EXISTS' }],
  ['USER_ACCOUNT_ABNORMAL', 403, { code: 'USER_ACCOUNT_ABNORMAL' }],
  ['SYSTEM_ERROR', 500, { code: 'SYSTEM_ERROR' }],
  ['白名单码配 HTTP 302', 302, { code: 'NOT_ENOUGH' }],
  ['串单：错误应答带别的退款单号', 403, { code: 'NOT_ENOUGH', out_refund_no: 'R-OTHER' }],
];

it.each(BUSINESS_ERRORS)(
  '[AC-B2-15k#409] 退款错误应答（%s）：只有 unknown，未知结果只查询',
  async (_name, status, body) => {
    const h = wechatChannel(() => wxAnswer(status, body));
    expectUnknown(await h.channel.refund(REFUND));
    expect(h.calls).toHaveLength(1);
  },
);

// ---- 退款查询

it('[AC-B2-15k#420] 退款查询请求：GET /v3/refund/domestic/refunds/{out_refund_no}，APIv3 签名；第二个参数可选', async () => {
  const h = wechatChannel(() => wxAnswer(200, wxRefund({ status: 'SUCCESS' })));
  okOf(await h.channel.refundQuery(OUT_REFUND));
  const request = h.calls[0]!;
  expect(request.method).toBe('GET');
  expect(request.url).toBe(
    `https://api.mch.weixin.qq.com/v3/refund/domestic/refunds/${OUT_REFUND}`,
  );
  expectWxSigned(request);
});

it('[AC-B2-15k#421] SUCCESS：带回 channelState、退款额、原单号、交易号、渠道退款号；文档没有 appid / mchid，用本配置值填身份', async () => {
  const h = wechatChannel(() => wxAnswer(200, wxRefund({ status: 'SUCCESS' })));
  const result = okOf(await h.channel.refundQuery(OUT_REFUND, ORIGINAL));
  expect(result.state).toBe('success');
  expect(result.channelState).toBe('SUCCESS');
  expect(result.refundFen).toBe(10n);
  expect(result.outTradeNo).toBe(OUT);
  expect(result.channelTradeNo).toBe(TRADE_NO);
  expect(result.channelRefundNo).toBe(REFUND_ID);
  expect(result.merchantRef).toBe(MCHID);
  expect(result.appRef).toBe(WX_APPID);
});

it('[AC-B2-15k#422] PROCESSING：摘要 processing，channelState 原样', async () => {
  const h = wechatChannel(() => wxAnswer(200, wxRefund({ status: 'PROCESSING' })));
  const result = okOf(await h.channel.refundQuery(OUT_REFUND));
  expect(result.state).toBe('processing');
  expect(result.channelState).toBe('PROCESSING');
});

it.each(['CLOSED', 'ABNORMAL'])(
  '[AC-B2-15k#423] %s：渠道原状态带回，由 refund_success_states / refund_fail_states 判定；摘要不得是 success',
  async (status) => {
    const h = wechatChannel(() => wxAnswer(200, wxRefund({ status })));
    const result = okOf(await h.channel.refundQuery(OUT_REFUND));
    expect(result.channelState).toBe(status);
    expect(result.state).not.toBe('success');
  },
);

it('[AC-B2-15k#427] 用代金券的单 refund=10、payer_refund=8：退款应答照常受理，查询的 refundFen 取退款金额，不取用户侧金额', async () => {
  const amount = { ...AMOUNT, payer_total: 90, payer_refund: 8 };
  const accepted = wechatChannel(() => wxAnswer(200, wxRefund({ amount })));
  expect(await accepted.channel.refund(REFUND)).toEqual({ kind: 'ok' });
  const queried = wechatChannel(() => wxAnswer(200, wxRefund({ status: 'SUCCESS', amount })));
  expect(okOf(await queried.channel.refundQuery(OUT_REFUND, ORIGINAL)).refundFen).toBe(10n);
});

it.each(wxEnvelopeFaults(JSON.stringify(wxRefund({ status: 'SUCCESS' }))))(
  '[AC-B2-15k#424] 退款查询应答不可信（%s）：unknown',
  async (_name, answer) => {
    const h = wechatChannel(() => answer);
    expectUnknown(await h.channel.refundQuery(OUT_REFUND));
  },
);

const BAD_REFUND_QUERY_ANSWERS: [string, Json][] = [
  ['退款单号不符', wxRefund({ status: 'SUCCESS', out_refund_no: 'R-OTHER' })],
  ['原商户单号与退款单的原单不符', wxRefund({ status: 'SUCCESS', out_trade_no: 'P-OTHER' })],
  [
    '交易号与退款单的原单不符',
    wxRefund({ status: 'SUCCESS', transaction_id: '42000000000000000002' }),
  ],
  ['带了别家的商户号', wxRefund({ status: 'SUCCESS', mchid: '1900000000' })],
  ['带了别家的应用', wxRefund({ status: 'SUCCESS', appid: 'wx-other' })],
  ['缺退款单号', without(wxRefund({ status: 'SUCCESS' }), 'out_refund_no')],
  ['缺状态', without(wxRefund(), 'status')],
  ['状态是对象', wxRefund({ status: { value: 'SUCCESS' } })],
  ['缺金额', without(wxRefund({ status: 'SUCCESS' }), 'amount')],
  ['金额是空对象', wxRefund({ status: 'SUCCESS', amount: {} })],
  ['退款额为负', wxRefund({ status: 'SUCCESS', amount: { ...AMOUNT, refund: -1 } })],
  ['退款额是字符串', wxRefund({ status: 'SUCCESS', amount: { ...AMOUNT, refund: '10' } })],
];

it.each(BAD_REFUND_QUERY_ANSWERS)(
  '[AC-B2-15k#425] 退款查询 200 验签通过但内容不对（%s）：unknown',
  async (_name, body) => {
    const h = wechatChannel(() => wxAnswer(200, body));
    expectUnknown(await h.channel.refundQuery(OUT_REFUND, ORIGINAL));
  },
);

const REFUND_QUERY_ERRORS: [string, number, Json][] = [
  [
    '404 RESOURCE_NOT_EXISTS（任务书 9.2 的「查无此单」例外只列了查单）',
    404,
    { code: 'RESOURCE_NOT_EXISTS' },
  ],
  ['404 MCH_NOT_EXISTS', 404, { code: 'MCH_NOT_EXISTS' }],
  ['500 SYSTEM_ERROR', 500, { code: 'SYSTEM_ERROR' }],
  ['串单：错误应答带别的退款单号', 404, { code: 'RESOURCE_NOT_EXISTS', out_refund_no: 'R-OTHER' }],
];

it.each(REFUND_QUERY_ERRORS)(
  '[AC-B2-15k#426] 退款查询错误（%s）：unknown',
  async (_name, status, body) => {
    const h = wechatChannel(() => wxAnswer(status, body));
    expectUnknown(await h.channel.refundQuery(OUT_REFUND));
  },
);
