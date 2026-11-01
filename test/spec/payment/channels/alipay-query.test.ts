// B2-15k 支付宝查单（claude-independent，SPEC_REF deb521c2）：08 BR-PAY-04（TRADE_FINISHED 实测前不算成功）、
// BR-PAY-05（单据不存在）；任务书 9.2、9.3、9.4（文档没有的身份字段由适配器用本配置值填）；r3 必须改 ①②④、建议改 ②③。
// 出处：docs-mirror/alipay/app-pay/02e7gm.md（业务响应 261、示例 267-312、错误码 319-323；没有 seller_id / app_id）、
// docs-mirror/alipay/guides/browser-02mse7.md:23-31（只对 xxx_response 的原文验签）、common-02km9f.md（主码）。未实测。
import { expect, it } from 'vitest';
import {
  ALIPAY_APPID,
  BUYER_LOGON,
  OPENID,
  OUT,
  PAY_APP_ID,
  QUERY_NODE,
  SANDBOX_GATEWAY,
  SELLER_ID,
  TRADE_NO,
  aliAnswer,
  aliBiz,
  aliEnvelopeFaults,
  aliError,
  aliMethod,
  aliParams,
  aliSign,
  aliTrade,
  alipayChannel,
  expectAliSigned,
  expectUnknown,
  okOf,
  rawAnswer,
  textOf,
  without,
  type Json,
} from './kit.ts';

it('[AC-B2-15k#701] 查单请求：alipay.trade.query，biz_content 只带 out_trade_no，发往配置的网关，RSA2 签名', async () => {
  const h = alipayChannel(() => aliAnswer(QUERY_NODE, aliTrade()));
  okOf(await h.channel.query(OUT));
  const request = h.calls[0]!;
  expect(request.method).toBe('POST');
  expect(request.url.startsWith(SANDBOX_GATEWAY)).toBe(true);
  expect(aliMethod(request)).toBe('alipay.trade.query');
  expect(aliBiz(request)).toEqual({ out_trade_no: OUT });
  expect(aliParams(request).get('timestamp')).toBe('2026-11-01 12:00:00');
  expectAliSigned(aliParams(request));
});

it('[AC-B2-15k#702] TRADE_SUCCESS：channelState 原样；文档没有 seller_id / app_id，用本配置值填身份；不含买家标识', async () => {
  const h = alipayChannel(() => aliAnswer(QUERY_NODE, aliTrade()));
  const result = okOf(await h.channel.query(OUT));
  expect(result.state).toBe('paid');
  expect(result.channelState).toBe('TRADE_SUCCESS');
  expect(result.channelTradeNo).toBe(TRADE_NO);
  expect(result.amountFen).toBe(100n);
  expect(result.merchantRef).toBe(SELLER_ID);
  expect(result.appRef).toBe(ALIPAY_APPID);
  expect(textOf(result)).not.toContain(OPENID);
  expect(textOf(result)).not.toContain(BUYER_LOGON);
});

it('[AC-B2-15k#703] TRADE_FINISHED：channelState 原样带回，但摘要不算 paid（BR-PAY-04 细则：实测前按不成功处理）', async () => {
  const h = alipayChannel(() =>
    aliAnswer(QUERY_NODE, aliTrade({ trade_status: 'TRADE_FINISHED' })),
  );
  const result = okOf(await h.channel.query(OUT));
  expect(result.channelState).toBe('TRADE_FINISHED');
  expect(result.state).not.toBe('paid');
});

it.each([
  ['WAIT_BUYER_PAY', 'not_paid'],
  ['TRADE_CLOSED', 'closed'],
])(
  '[AC-B2-15k#704] %s：未生成真实交易时可以没有 trade_no（文档注意事项），摘要 %s',
  async (status, summary) => {
    const h = alipayChannel(() =>
      aliAnswer(
        QUERY_NODE,
        without(aliTrade({ trade_status: status }), 'trade_no', 'buyer_logon_id'),
      ),
    );
    const result = okOf(await h.channel.query(OUT));
    expect(result.state).toBe(summary);
    expect(result.channelState).toBe(status);
    expect(result.channelTradeNo).toBeNull();
  },
);

it('[AC-B2-15k#705] 未知的 trade_status：摘要不得是 paid', async () => {
  const h = alipayChannel(() => aliAnswer(QUERY_NODE, aliTrade({ trade_status: 'SOMETHING_NEW' })));
  const result = await h.channel.query(OUT);
  if (result.kind === 'ok') {
    expect(result.state).not.toBe('paid');
    expect(result.channelState).toBe('SOMETHING_NEW');
  } else {
    expectUnknown(result);
  }
});

it.each([
  ['0.01', 1n],
  ['0.99', 99n],
  ['1.00', 100n],
  ['1.01', 101n],
  ['21474836.48', 2147483648n],
  ['21474836.49', 2147483649n],
])('[AC-B2-15k#706] 金额边界 total_amount=%s → %s 分（不经浮点）', async (yuan, fen) => {
  const h = alipayChannel(() => aliAnswer(QUERY_NODE, aliTrade({ total_amount: yuan })));
  expect(okOf(await h.channel.query(OUT)).amountFen).toBe(fen);
});

it('[AC-B2-15k#707] 只对 xxx_response 的原文验签：转义的正斜杠、Unicode 转义、空白都按线上字节算，不重新序列化', async () => {
  const raw =
    `{ "code" : "10000", "msg":"http:\\/\\/\\u4e2d", "trade_no":"${TRADE_NO}", ` +
    `"out_trade_no":"${OUT}", "trade_status":"TRADE_SUCCESS", "total_amount":"1.00" }`;
  const h = alipayChannel(() =>
    rawAnswer(`{"${QUERY_NODE}":${raw},"sign":${JSON.stringify(aliSign(raw))}}`),
  );
  expect(okOf(await h.channel.query(OUT)).channelState).toBe('TRADE_SUCCESS');
});

it.each(aliEnvelopeFaults(QUERY_NODE, aliTrade()))(
  '[AC-B2-15k#708] 查单应答外壳不可信（%s）：unknown',
  async (_name, answer) => {
    const h = alipayChannel(() => answer);
    expectUnknown(await h.channel.query(OUT));
  },
);

const BAD_TRADES: [string, Json][] = [
  ['单号不符', aliTrade({ out_trade_no: 'P-OTHER' })],
  ['缺单号', without(aliTrade(), 'out_trade_no')],
  ['单号是数字', aliTrade({ out_trade_no: 42 })],
  ['带了别家的 seller_id', aliTrade({ seller_id: '2088000000000002' })],
  ['带了别家的 app_id', aliTrade({ app_id: '2021000000000002' })],
  ['缺状态', without(aliTrade(), 'trade_status')],
  ['状态是对象', aliTrade({ trade_status: { value: 'TRADE_SUCCESS' } })],
  ['TRADE_SUCCESS 缺交易号', without(aliTrade(), 'trade_no')],
  ['交易号是数字', aliTrade({ trade_no: 42 })],
  ['TRADE_SUCCESS 缺金额', without(aliTrade(), 'total_amount')],
  ['金额为负', aliTrade({ total_amount: '-1.00' })],
  ['金额不是金额', aliTrade({ total_amount: 'NOT_MONEY' })],
  ['金额是数字而不是字符串', aliTrade({ total_amount: 1 })],
  ['金额是对象', aliTrade({ total_amount: { value: '1.00' } })],
  ['金额三位小数', aliTrade({ total_amount: '1.234' })],
  ['金额科学计数', aliTrade({ total_amount: '1e2' })],
  ['金额空串', aliTrade({ total_amount: '' })],
  ['10000 却带 sub_code', aliTrade({ sub_code: 'ACQ.SYSTEM_ERROR' })],
  ['code 是数字', aliTrade({ code: 10000 })],
  ['缺 code', without(aliTrade(), 'code')],
];

it.each(BAD_TRADES)(
  '[AC-B2-15k#709] 查单 10000 验签通过但内容不对（%s）：unknown',
  async (_name, node) => {
    const h = alipayChannel(() => aliAnswer(QUERY_NODE, node));
    expectUnknown(await h.channel.query(OUT));
  },
);

it('[AC-B2-15k#710] 验签通过的 40004 + ACQ.TRADE_NOT_EXIST：not_exist，没有金额和交易号', async () => {
  const h = alipayChannel(() => aliAnswer(QUERY_NODE, aliError('40004', 'ACQ.TRADE_NOT_EXIST')));
  const result = okOf(await h.channel.query(OUT));
  expect(result.state).toBe('not_exist');
  expect(result.amountFen).toBeNull();
  expect(result.channelTradeNo).toBeNull();
});

const NOT_EXIST_COUNTEREXAMPLES: [string, Json][] = [
  ['白名单子码配 20000', aliError('20000', 'ACQ.TRADE_NOT_EXIST')],
  ['白名单子码配 99999', aliError('99999', 'ACQ.TRADE_NOT_EXIST')],
  ['白名单子码配 40005', aliError('40005', 'ACQ.TRADE_NOT_EXIST')],
  ['白名单子码配 40002', aliError('40002', 'ACQ.TRADE_NOT_EXIST')],
  ['40004 配没有 ACQ 前缀的子码', aliError('40004', 'TRADE_NOT_EXIST')],
  ['40004 配别的子码', aliError('40004', 'ACQ.SYSTEM_ERROR')],
  ['40004 缺子码', { code: '40004', msg: 'msg' }],
  ['子码是对象', { code: '40004', msg: 'msg', sub_code: { value: 'ACQ.TRADE_NOT_EXIST' } }],
  [
    '串单：错误应答带别的单号',
    aliError('40004', 'ACQ.TRADE_NOT_EXIST', { out_trade_no: 'P-OTHER' }),
  ],
  [
    '串单：错误应答带别的 app_id',
    aliError('40004', 'ACQ.TRADE_NOT_EXIST', { app_id: '2021000000000002' }),
  ],
  ['系统错误', aliError('20000', 'isp.unknow-error')],
  ['权限不足', aliError('40006', 'isv.insufficient-isv-permissions')],
];

it.each(NOT_EXIST_COUNTEREXAMPLES)(
  '[AC-B2-15k#711] 「查无此单」矩阵的反例（%s）：unknown，不是 not_exist',
  async (_name, node) => {
    const h = alipayChannel(() => aliAnswer(QUERY_NODE, node));
    expectUnknown(await h.channel.query(OUT));
  },
);

it('[AC-B2-15k#712] 未验签的 40004 + ACQ.TRADE_NOT_EXIST、HTTP 非 200 的同样内容：unknown', async () => {
  const node = aliError('40004', 'ACQ.TRADE_NOT_EXIST');
  const unsigned = alipayChannel(() => rawAnswer(`{"${QUERY_NODE}":${JSON.stringify(node)}}`));
  expectUnknown(await unsigned.channel.query(OUT));
  const http = alipayChannel(() => ({ ...aliAnswer(QUERY_NODE, node), status: 500 }));
  expectUnknown(await http.channel.query(OUT));
  const iface = alipayChannel(() => aliAnswer('alipay_trade_close_response', node));
  expectUnknown(await iface.channel.query(OUT));
});

it('[AC-B2-15k#713] transport 抛异常：unknown，不抛；只发一次', async () => {
  const h = alipayChannel(() => {
    throw new Error('boom');
  });
  expectUnknown(await h.channel.query(OUT));
  expect(h.calls).toHaveLength(1);
});

it('[AC-B2-15k#715] ownerAppOf：只有配置的 seller_id + app_id 才属于 PAY_APP_ID，其余 null', () => {
  const { channel } = alipayChannel();
  expect(channel.channel).toBe('alipay');
  expect(channel.ownerAppOf({ merchantRef: SELLER_ID, appRef: ALIPAY_APPID })).toBe(PAY_APP_ID);
  expect(channel.ownerAppOf({ merchantRef: '2088000000000002', appRef: ALIPAY_APPID })).toBeNull();
  expect(channel.ownerAppOf({ merchantRef: SELLER_ID, appRef: '2021000000000002' })).toBeNull();
});
