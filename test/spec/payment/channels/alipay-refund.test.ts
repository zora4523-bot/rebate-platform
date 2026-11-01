// B2-15k 支付宝退款与退款查询（claude-independent，SPEC_REF deb521c2）：08 BR-PAY-06 ④⑤；任务书 9.4：refund 的 ok
// 只表示受理，fund_change 不决定结果，以 refundQuery 为准；退款查询必须带原交易号，缺了就 unknown；「10000 且无退款
// 信息」是 not_exist，带退款信息就必须带齐并匹配身份字段。r3 必须改 ③ 第一、二条，④。
// 出处：docs-mirror/alipay/app-pay/02e7go.md（退款）、02e7gp.md（退款查询：refund_status 仅 REFUND_SUCCESS，未返回表示
// 未收到或失败）、01dcc0.md:112-113、235（部分退款用不同 out_request_no）。未实测（BR-PAY-09）。
import { expect, it } from 'vitest';
import {
  ALIPAY_APPID,
  ORIGINAL,
  OUT,
  OUT_REFUND,
  REFUND,
  REFUND_NODE,
  REFUND_QUERY_NODE,
  SELLER_ID,
  TRADE_NO,
  aliAnswer,
  aliBiz,
  aliEnvelopeFaults,
  aliError,
  aliMethod,
  aliParams,
  aliRefundAnswer,
  aliRefundQueryAnswer,
  alipayChannel,
  expectAliSigned,
  expectUnknown,
  okOf,
  without,
  type Json,
} from './kit.ts';

it('[AC-B2-15k#901] 退款请求：alipay.trade.refund，out_request_no 用退款单号，refund_amount 是元（不经浮点），RSA2 签名', async () => {
  const h = alipayChannel(() => aliAnswer(REFUND_NODE, aliRefundAnswer()));
  expect(await h.channel.refund(REFUND)).toEqual({ kind: 'ok' });
  const request = h.calls[0]!;
  expect(aliMethod(request)).toBe('alipay.trade.refund');
  expect(aliBiz(request)).toMatchObject({
    out_trade_no: OUT,
    out_request_no: OUT_REFUND,
    refund_amount: '0.10',
  });
  expectAliSigned(aliParams(request));
});

it('[AC-B2-15k#902] 异常收款没有商户单号：用 trade_no 退款', async () => {
  const input = { ...REFUND, outTradeNo: null, channelTradeNo: TRADE_NO };
  const h = alipayChannel(() =>
    aliAnswer(REFUND_NODE, aliRefundAnswer({ out_trade_no: 'P-CHANNEL-SIDE' })),
  );
  expect(await h.channel.refund(input)).toEqual({ kind: 'ok' });
  expect(aliBiz(h.calls[0]!)).toMatchObject({ trade_no: TRADE_NO, out_request_no: OUT_REFUND });
});

it('[AC-B2-15k#903] 原单既没有商户单号也没有交易号：unknown，不发请求', async () => {
  const h = alipayChannel(() => aliAnswer(REFUND_NODE, aliRefundAnswer()));
  expectUnknown(await h.channel.refund({ ...REFUND, outTradeNo: null, channelTradeNo: null }));
  expect(h.calls).toHaveLength(0);
});

it.each([
  [1n, '0.01'],
  [99n, '0.99'],
  [100n, '1.00'],
  [101n, '1.01'],
  [2147483649n, '21474836.49'],
])('[AC-B2-15k#904] 金额边界 退 %s 分 → refund_amount %s', async (refundFen, yuan) => {
  const h = alipayChannel(() => aliAnswer(REFUND_NODE, aliRefundAnswer({ refund_fee: yuan })));
  expect(await h.channel.refund({ ...REFUND, refundFen, totalFen: 2147483649n })).toEqual({
    kind: 'ok',
  });
  expect(aliBiz(h.calls[0]!)).toMatchObject({ refund_amount: yuan });
});

it.each([
  ['退款金额为 0', 0n],
  ['退款金额为负', -1n],
])('[AC-B2-15k#905] %s：unknown，不发请求', async (_name, refundFen) => {
  const h = alipayChannel(() => aliAnswer(REFUND_NODE, aliRefundAnswer()));
  expectUnknown(await h.channel.refund({ ...REFUND, refundFen }));
  expect(h.calls).toHaveLength(0);
});

it.each(['Y', 'N'])(
  '[AC-B2-15k#906] fund_change=%s 都只是受理（01dcc0.md:113 只表示本次请求是否资金变动）：结果里没有退款状态',
  async (fundChange) => {
    const h = alipayChannel(() =>
      aliAnswer(REFUND_NODE, aliRefundAnswer({ fund_change: fundChange })),
    );
    expect(await h.channel.refund(REFUND)).toEqual({ kind: 'ok' });
  },
);

it('[AC-B2-15k#907] r3 必须改 ③ 第二条：同一笔部分退款各用自己的 out_request_no；复用第一笔已签名的 fund_change=Y 应答不算数，第二笔的结果只认它自己的退款查询', async () => {
  const first = { ...REFUND, outRefundNo: 'R-FIRST', refundFen: 10n };
  const second = { ...REFUND, outRefundNo: 'R-SECOND', refundFen: 20n };
  const replayed = aliAnswer(
    REFUND_NODE,
    aliRefundAnswer({ fund_change: 'Y', refund_fee: '0.30' }),
  );
  const h = alipayChannel((request) =>
    aliMethod(request) === 'alipay.trade.refund'
      ? replayed
      : aliAnswer(REFUND_QUERY_NODE, aliRefundQueryAnswer({ out_request_no: 'R-FIRST' })),
  );
  await h.channel.refund(first);
  const answered = await h.channel.refund(second);
  expect(answered.kind === 'ok' ? Object.keys(answered) : ['kind']).toEqual(['kind']);
  expect(h.calls.map((call) => aliBiz(call)['out_request_no'])).toEqual(['R-FIRST', 'R-SECOND']);
  // 第二笔查到的是第一笔的退款记录：不算第二笔成功。
  expectUnknown(await h.channel.refundQuery('R-SECOND', ORIGINAL));
});

it.each(aliEnvelopeFaults(REFUND_NODE, aliRefundAnswer()))(
  '[AC-B2-15k#908] 退款应答外壳不可信（%s）：unknown',
  async (_name, answer) => {
    const h = alipayChannel(() => answer);
    expectUnknown(await h.channel.refund(REFUND));
  },
);

const BAD_REFUNDS: [string, Json][] = [
  ['单号不符', aliRefundAnswer({ out_trade_no: 'P-OTHER' })],
  ['缺单号', without(aliRefundAnswer(), 'out_trade_no')],
  ['缺交易号', without(aliRefundAnswer(), 'trade_no')],
  ['带了别的退款请求号', aliRefundAnswer({ out_request_no: 'R-OTHER' })],
  ['带了别家的 app_id', aliRefundAnswer({ app_id: '2021000000000002' })],
  ['refund_fee 为负', aliRefundAnswer({ refund_fee: '-1.00' })],
  ['refund_fee 不是金额', aliRefundAnswer({ refund_fee: 'NOT_MONEY' })],
  ['refund_fee 是对象', aliRefundAnswer({ refund_fee: { value: '0.10' } })],
  ['refund_fee 是数字', aliRefundAnswer({ refund_fee: 0.1 })],
  ['refund_fee 累计超过订单总额', aliRefundAnswer({ refund_fee: '1.01' })],
  ['缺 refund_fee', without(aliRefundAnswer(), 'refund_fee')],
  ['fund_change 是对象', aliRefundAnswer({ fund_change: { value: 'Y' } })],
  ['10000 却带 sub_code', aliRefundAnswer({ sub_code: 'ACQ.SYSTEM_ERROR' })],
];

it.each(BAD_REFUNDS)(
  '[AC-B2-15k#909] 退款 10000 验签通过但与请求不符（%s）：unknown',
  async (_name, node) => {
    const h = alipayChannel(() => aliAnswer(REFUND_NODE, node));
    expectUnknown(await h.channel.refund(REFUND));
  },
);

const REFUND_ERRORS: [string, Json][] = [
  ['ACQ.SELLER_BALANCE_NOT_ENOUGH', aliError('40004', 'ACQ.SELLER_BALANCE_NOT_ENOUGH')],
  ['ACQ.TRADE_NOT_EXIST', aliError('40004', 'ACQ.TRADE_NOT_EXIST')],
  ['ACQ.SYSTEM_ERROR（文档：可能成功也可能失败）', aliError('40004', 'ACQ.SYSTEM_ERROR')],
  ['主码 20000', aliError('20000', 'isp.unknow-error')],
  [
    '串单：错误应答带别的单号',
    aliError('40004', 'ACQ.TRADE_HAS_CLOSE', { out_trade_no: 'P-OTHER' }),
  ],
];

it.each(REFUND_ERRORS)(
  '[AC-B2-15k#910] 退款错误应答（%s）：只有 unknown，只发一次（未知结果只查询，不重提）',
  async (_name, node) => {
    const h = alipayChannel(() => aliAnswer(REFUND_NODE, node));
    expectUnknown(await h.channel.refund(REFUND));
    expect(h.calls).toHaveLength(1);
  },
);

// ---- 退款查询

it('[AC-B2-15k#920] 退款查询请求：alipay.trade.fastpay.refund.query，带 out_request_no 与原交易号，RSA2 签名', async () => {
  const h = alipayChannel(() => aliAnswer(REFUND_QUERY_NODE, aliRefundQueryAnswer()));
  okOf(await h.channel.refundQuery(OUT_REFUND, ORIGINAL));
  const request = h.calls[0]!;
  expect(aliMethod(request)).toBe('alipay.trade.fastpay.refund.query');
  const biz = aliBiz(request);
  expect(biz['out_request_no']).toBe(OUT_REFUND);
  expect(biz['out_trade_no'] ?? biz['trade_no']).toBeDefined();
  expectAliSigned(aliParams(request));
});

it.each([
  ['第二参缺失', undefined],
  ['原单号都是 null', { outTradeNo: null, channelTradeNo: null }],
])(
  '[AC-B2-15k#921] 退款查询缺原交易号（%s）：unknown，不发请求（01dcc0.md 要求与退款一致）',
  async (_name, original) => {
    const h = alipayChannel(() => aliAnswer(REFUND_QUERY_NODE, aliRefundQueryAnswer()));
    expectUnknown(await h.channel.refundQuery(OUT_REFUND, original));
    expect(h.calls).toHaveLength(0);
  },
);

it('[AC-B2-15k#922] REFUND_SUCCESS：带回 channelState、退款额、原单号、交易号；文档没有 seller_id / app_id，用本配置值', async () => {
  const h = alipayChannel(() => aliAnswer(REFUND_QUERY_NODE, aliRefundQueryAnswer()));
  const result = okOf(await h.channel.refundQuery(OUT_REFUND, ORIGINAL));
  expect(result.state).toBe('success');
  expect(result.channelState).toBe('REFUND_SUCCESS');
  expect(result.refundFen).toBe(10n);
  expect(result.outTradeNo).toBe(OUT);
  expect(result.channelTradeNo).toBe(TRADE_NO);
  expect(result.merchantRef).toBe(SELLER_ID);
  expect(result.appRef).toBe(ALIPAY_APPID);
});

it('[AC-B2-15k#923] 10000 且没有任何退款信息：not_exist，没有退款额', async () => {
  const h = alipayChannel(() => aliAnswer(REFUND_QUERY_NODE, { code: '10000', msg: 'Success' }));
  const result = okOf(await h.channel.refundQuery(OUT_REFUND, ORIGINAL));
  expect(result.state).toBe('not_exist');
  expect(result.refundFen).toBeNull();
});

it.each([
  ['0.01', 1n],
  ['0.99', 99n],
  ['1.00', 100n],
  ['1.01', 101n],
  ['21474836.49', 2147483649n],
])('[AC-B2-15k#924] 金额边界 refund_amount=%s → %s 分', async (yuan, fen) => {
  const h = alipayChannel(() =>
    aliAnswer(REFUND_QUERY_NODE, aliRefundQueryAnswer({ refund_amount: yuan })),
  );
  expect(okOf(await h.channel.refundQuery(OUT_REFUND, ORIGINAL)).refundFen).toBe(fen);
});

it.each(aliEnvelopeFaults(REFUND_QUERY_NODE, aliRefundQueryAnswer()))(
  '[AC-B2-15k#925] 退款查询应答外壳不可信（%s）：unknown',
  async (_name, answer) => {
    const h = alipayChannel(() => answer);
    expectUnknown(await h.channel.refundQuery(OUT_REFUND, ORIGINAL));
  },
);

const BAD_REFUND_QUERIES: [string, Json][] = [
  [
    'r3 ③ 第一条：只有状态和金额，没有任何身份字段',
    { code: '10000', msg: 'Success', refund_status: 'REFUND_SUCCESS', refund_amount: '0.10' },
  ],
  ['缺 out_request_no', without(aliRefundQueryAnswer(), 'out_request_no')],
  ['缺 out_trade_no', without(aliRefundQueryAnswer(), 'out_trade_no')],
  ['out_request_no 不符', aliRefundQueryAnswer({ out_request_no: 'R-OTHER' })],
  ['out_trade_no 不符', aliRefundQueryAnswer({ out_trade_no: 'P-OTHER' })],
  ['trade_no 不符', aliRefundQueryAnswer({ trade_no: '42000000000000000002' })],
  ['带了别家的 seller_id', aliRefundQueryAnswer({ seller_id: '2088000000000002' })],
  ['refund_status 是对象', aliRefundQueryAnswer({ refund_status: { value: 'REFUND_SUCCESS' } })],
  ['refund_status 是数字', aliRefundQueryAnswer({ refund_status: 1 })],
  ['REFUND_SUCCESS 缺退款额', without(aliRefundQueryAnswer(), 'refund_amount')],
  ['refund_amount=-1', aliRefundQueryAnswer({ refund_amount: '-1' })],
  ['refund_amount 不是金额', aliRefundQueryAnswer({ refund_amount: 'NOT_MONEY' })],
  ['refund_amount 是数字', aliRefundQueryAnswer({ refund_amount: 0.1 })],
  ['refund_amount 三位小数', aliRefundQueryAnswer({ refund_amount: '0.101' })],
];

it.each(BAD_REFUND_QUERIES)(
  '[AC-B2-15k#926] 退款查询 10000 验签通过但内容不对（%s）：unknown',
  async (_name, node) => {
    const h = alipayChannel(() => aliAnswer(REFUND_QUERY_NODE, node));
    expectUnknown(await h.channel.refundQuery(OUT_REFUND, ORIGINAL));
  },
);

it('[AC-B2-15k#927] 带退款信息但没有 refund_status（文档：未收到或失败）：不算成功', async () => {
  const h = alipayChannel(() =>
    aliAnswer(REFUND_QUERY_NODE, without(aliRefundQueryAnswer(), 'refund_status')),
  );
  const result = await h.channel.refundQuery(OUT_REFUND, ORIGINAL);
  if (result.kind === 'ok') {
    expect(result.state).not.toBe('success');
    expect(result.channelState).not.toBe('REFUND_SUCCESS');
  } else {
    expectUnknown(result);
  }
});

it('[AC-B2-15k#928] 原单只有渠道交易号（异常收款）：按 trade_no 查，不比对商户单号', async () => {
  const h = alipayChannel(() =>
    aliAnswer(REFUND_QUERY_NODE, aliRefundQueryAnswer({ out_trade_no: 'P-CHANNEL-SIDE' })),
  );
  const result = okOf(
    await h.channel.refundQuery(OUT_REFUND, { outTradeNo: null, channelTradeNo: TRADE_NO }),
  );
  expect(result.channelState).toBe('REFUND_SUCCESS');
  expect(aliBiz(h.calls[0]!)['trade_no']).toBe(TRADE_NO);
});

const REFUND_QUERY_ERRORS: [string, Json][] = [
  [
    '40004 ACQ.TRADE_NOT_EXIST（「查无此单」例外只列了查单）',
    aliError('40004', 'ACQ.TRADE_NOT_EXIST'),
  ],
  ['40004 TRADE_NOT_EXIST', aliError('40004', 'TRADE_NOT_EXIST')],
  ['40004 ACQ.SYSTEM_ERROR', aliError('40004', 'ACQ.SYSTEM_ERROR')],
  ['主码 20000', aliError('20000', 'isp.unknow-error')],
];

it.each(REFUND_QUERY_ERRORS)('[AC-B2-15k#929] 退款查询错误（%s）：unknown', async (_name, node) => {
  const h = alipayChannel(() => aliAnswer(REFUND_QUERY_NODE, node));
  expectUnknown(await h.channel.refundQuery(OUT_REFUND, ORIGINAL));
});
