// B2-15k 微信查单（claude-independent，SPEC_REF deb521c2）：08 BR-PAY-04（判定由 pay-settlement 做，适配器只如实
// 带回原状态与身份，换算不经浮点）；BR-PAY-05（「单据不存在」）；任务书 9.2、9.3；r3 必须改 ①②④。
// 出处：docs-mirror/wechat-pay/pages/4013070356.txt（字段 450-561，错误码 613-685：404 ORDER_NOT_EXIST）。
// 未实测（BR-PAY-09）。
import { expect, it } from 'vitest';
import type { PayHttpResponse } from '../../../../apps/api/src/modules/payment/infra/channels/transport.ts';
import {
  MCHID,
  OPENID,
  OUT,
  PAY_APP_ID,
  TRADE_NO,
  WX_APPID,
  expectUnknown,
  expectWxSigned,
  okOf,
  textOf,
  wechatChannel,
  without,
  wxAnswer,
  wxEnvelopeFaults,
  wxTrade,
  type Json,
} from './kit.ts';

it('[AC-B2-15k#201] 查单请求：GET 商户单号路径带 mchid，签名覆盖 path+query；单号做路径编码', async () => {
  const h = wechatChannel(() => wxAnswer(200, wxTrade({ out_trade_no: 'P/1 2' })));
  okOf(await h.channel.query('P/1 2'));
  const request = h.calls[0]!;
  expect(request.method).toBe('GET');
  expect(request.url).toBe(
    `https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/P%2F1%202?mchid=${MCHID}`,
  );
  expect(request.body ?? '').toBe('');
  expectWxSigned(request);
});

it('[AC-B2-15k#202] SUCCESS：channelState 原样，merchantRef / appRef 取应答，金额取 amount.total；结果不含渠道用户标识', async () => {
  const h = wechatChannel(() => wxAnswer(200, wxTrade()));
  const result = okOf(await h.channel.query(OUT));
  expect(result.state).toBe('paid');
  expect(result.channelState).toBe('SUCCESS');
  expect(result.merchantRef).toBe(MCHID);
  expect(result.appRef).toBe(WX_APPID);
  expect(result.channelTradeNo).toBe(TRADE_NO);
  expect(result.amountFen).toBe(100n);
  expect(textOf(result)).not.toContain(OPENID);
});

it.each([
  ['NOTPAY', 'not_paid'],
  ['CLOSED', 'closed'],
])(
  '[AC-B2-15k#203] %s：未支付的单没有交易号、金额也可缺（文档都是选填），摘要 %s',
  async (state, summary) => {
    const body = without(
      wxTrade({ trade_state: state }),
      'transaction_id',
      'payer',
      'amount',
      'success_time',
    );
    const h = wechatChannel(() => wxAnswer(200, body));
    const result = okOf(await h.channel.query(OUT));
    expect(result.state).toBe(summary);
    expect(result.channelState).toBe(state);
    expect(result.channelTradeNo).toBeNull();
    expect(result.amountFen).toBeNull();
    expect(result.merchantRef).toBe(MCHID);
    expect(result.appRef).toBe(WX_APPID);
  },
);

it.each(['REFUND', 'REVOKED', 'USERPAYING', 'PAYERROR', 'SOMETHING_NEW'])(
  '[AC-B2-15k#204] %s 不是支付成功：摘要不得是 paid；有结果时 channelState 原样',
  async (state) => {
    const h = wechatChannel(() => wxAnswer(200, wxTrade({ trade_state: state })));
    const result = await h.channel.query(OUT);
    if (result.kind === 'ok') {
      expect(result.state).not.toBe('paid');
      expect(result.channelState).toBe(state);
    } else {
      expectUnknown(result);
    }
  },
);

it.each([
  [1, 1n],
  [99, 99n],
  [100, 100n],
  [101, 101n],
  [2147483648, 2147483648n],
  [2147483649, 2147483649n],
])('[AC-B2-15k#205] 金额边界 total=%s：换算成同值 bigint 分', async (total, fen) => {
  const h = wechatChannel(() =>
    wxAnswer(200, wxTrade({ amount: { total, payer_total: total, currency: 'CNY' } })),
  );
  expect(okOf(await h.channel.query(OUT)).amountFen).toBe(fen);
});

it('[AC-B2-15k#213] 用代金券的单 total=100、payer_total=90：amountFen 取订单总金额，不取用户实付（BR-PAY-04 细则）', async () => {
  const amount = { total: 100, payer_total: 90, currency: 'CNY', payer_currency: 'CNY' };
  const h = wechatChannel(() => wxAnswer(200, wxTrade({ amount })));
  expect(okOf(await h.channel.query(OUT)).amountFen).toBe(100n);
});

it.each(wxEnvelopeFaults(JSON.stringify(wxTrade())))(
  '[AC-B2-15k#206] 查单应答不可信（%s）：unknown',
  async (_name, answer) => {
    const h = wechatChannel(() => answer);
    expectUnknown(await h.channel.query(OUT));
  },
);

it.each([
  ['单号不符', wxTrade({ out_trade_no: 'P-OTHER' })],
  ['商户号不符', wxTrade({ mchid: '1900000000' })],
  ['应用不符', wxTrade({ appid: 'wx-other' })],
  ['缺单号', without(wxTrade(), 'out_trade_no')],
  ['缺商户号', without(wxTrade(), 'mchid')],
  ['缺应用', without(wxTrade(), 'appid')],
  ['缺状态', without(wxTrade(), 'trade_state')],
  ['状态是对象', wxTrade({ trade_state: { value: 'SUCCESS' } })],
  ['状态是数字', wxTrade({ trade_state: 1 })],
  ['单号是数字', wxTrade({ out_trade_no: 42 })],
  ['SUCCESS 缺交易号', without(wxTrade(), 'transaction_id')],
  ['SUCCESS 交易号是空串', wxTrade({ transaction_id: '' })],
  ['SUCCESS 缺金额', without(wxTrade(), 'amount')],
  ['SUCCESS 金额缺 total', wxTrade({ amount: { currency: 'CNY' } })],
  ['金额是数组', wxTrade({ amount: [] })],
  ['金额是字符串', wxTrade({ amount: '100' })],
  ['total 是字符串', wxTrade({ amount: { total: '100', currency: 'CNY' } })],
  ['total 是对象', wxTrade({ amount: { total: { value: 100 }, currency: 'CNY' } })],
  ['total 为负', wxTrade({ amount: { total: -1, currency: 'CNY' } })],
  ['total 是小数', wxTrade({ amount: { total: 1.5, currency: 'CNY' } })],
  ['币种不是 CNY', wxTrade({ amount: { total: 100, currency: 'USD' } })],
])('[AC-B2-15k#207] 查单 200 验签通过但内容不对（%s）：unknown', async (_name, body) => {
  const h = wechatChannel(() => wxAnswer(200, body));
  expectUnknown(await h.channel.query(OUT));
});

it('[AC-B2-15k#208] total 超出安全整数（JSON 精度已丢）：unknown，不算出一个错的金额', async () => {
  const body = JSON.stringify(wxTrade()).replace('"total":100', '"total":9007199254740993');
  const h = wechatChannel(() => wxAnswer(200, body));
  expectUnknown(await h.channel.query(OUT));
});

it('[AC-B2-15k#209] 验签通过的 404 + ORDER_NOT_EXIST：not_exist，没有金额和交易号', async () => {
  const h = wechatChannel(() => wxAnswer(404, { code: 'ORDER_NOT_EXIST', message: 'message' }));
  const result = okOf(await h.channel.query(OUT));
  expect(result.state).toBe('not_exist');
  expect(result.amountFen).toBeNull();
  expect(result.channelTradeNo).toBeNull();
});

// NOT_FOUND、RESOURCE_NOT_EXISTS 不在 4013070356.txt 的错误码表里，是这里选的任意错误码，只用来钉「别的码不算查无此单」。
const NOT_EXIST_COUNTEREXAMPLES: [string, number, Json][] = [
  ['主码对、HTTP 400', 400, { code: 'ORDER_NOT_EXIST' }],
  ['主码对、HTTP 403', 403, { code: 'ORDER_NOT_EXIST' }],
  ['主码对、HTTP 302', 302, { code: 'ORDER_NOT_EXIST' }],
  ['主码对、HTTP 500', 500, { code: 'ORDER_NOT_EXIST' }],
  ['HTTP 对、别的码 NOT_FOUND', 404, { code: 'NOT_FOUND' }],
  ['HTTP 对、别的码 RESOURCE_NOT_EXISTS', 404, { code: 'RESOURCE_NOT_EXISTS' }],
  ['HTTP 对、别的码 MCH_NOT_EXISTS', 404, { code: 'MCH_NOT_EXISTS' }],
  ['HTTP 对、没有码', 404, { message: 'message' }],
  ['HTTP 对、码是数字', 404, { code: 404 }],
  ['串单：错误应答带别的单号', 404, { code: 'ORDER_NOT_EXIST', out_trade_no: 'P-OTHER' }],
  ['串单：错误应答带别的商户号', 404, { code: 'ORDER_NOT_EXIST', mchid: '1900000000' }],
  ['串单：错误应答带别的应用', 404, { code: 'ORDER_NOT_EXIST', appid: 'wx-other' }],
  ['其他业务错误', 403, { code: 'TRADE_ERROR' }],
  ['限频', 429, { code: 'FREQUENCY_LIMITED' }],
];

it.each(NOT_EXIST_COUNTEREXAMPLES)(
  '[AC-B2-15k#210] 「查无此单」矩阵的反例（%s）：unknown，不是 not_exist',
  async (_name, status, body) => {
    const h = wechatChannel(() => wxAnswer(status, body));
    expectUnknown(await h.channel.query(OUT));
  },
);

const UNVERIFIED_NOT_EXIST: [string, PayHttpResponse][] = [
  ['缺签名头', { status: 404, headers: {}, body: '{"code":"ORDER_NOT_EXIST"}' }],
  ['签名不对', wxAnswer(404, { code: 'ORDER_NOT_EXIST' }, { signature: 'bm90LWEtc2lnbmF0dXJl' })],
  ['序列号不符', wxAnswer(404, { code: 'ORDER_NOT_EXIST' }, { serial: 'PUB_KEY_ID_OTHER' })],
];

it.each(UNVERIFIED_NOT_EXIST)(
  '[AC-B2-15k#211] 未验签的 404 + ORDER_NOT_EXIST（%s）：unknown',
  async (_name, answer) => {
    const h = wechatChannel(() => answer);
    expectUnknown(await h.channel.query(OUT));
  },
);

it('[AC-B2-15k#212] ownerAppOf：只有配置的商户号 + 应用才属于 PAY_APP_ID，其余 null', () => {
  const { channel } = wechatChannel();
  expect(channel.channel).toBe('wechat_pay');
  expect(channel.ownerAppOf({ merchantRef: MCHID, appRef: WX_APPID })).toBe(PAY_APP_ID);
  expect(channel.ownerAppOf({ merchantRef: '1900000000', appRef: WX_APPID })).toBeNull();
  expect(channel.ownerAppOf({ merchantRef: MCHID, appRef: 'wx-other' })).toBeNull();
  expect(channel.ownerAppOf({ merchantRef: '', appRef: '' })).toBeNull();
});
