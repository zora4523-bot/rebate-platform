// B2-15k 微信关单（claude-independent，SPEC_REF deb521c2）：08 BR-PAY-05 ②（先查后关，只有渠道明确「已关闭」才算；
// 「单据不存在」不等于已关闭）；任务书 9.3 与第 13 节裁定；r3 必须改 ③。204 和验过签的业务错误都不算关闭成功，必须再查一次单。
// 出处：docs-mirror/wechat-pay/pages/4013070360.txt（204 无应答包体）、4013053249.txt:41（空正文的验签串末行
// 只有一个 \n）、4013070356.txt。未实测（BR-PAY-09）。
import { createSign } from 'node:crypto';
import { expect, it } from 'vitest';
import type {
  PayHttpRequest,
  PayHttpResponse,
} from '../../../../apps/api/src/modules/payment/infra/channels/transport.ts';
import {
  MCHID,
  NOW_S,
  OTHER,
  OUT,
  WECHAT_PLATFORM,
  expectUnknown,
  expectWxSigned,
  okOf,
  wechatChannel,
  wxAnswer,
  wxTrade,
  type Route,
} from './kit.ts';

function isClose(request: PayHttpRequest): boolean {
  return request.url.endsWith('/close');
}

/** 关单接口按 closeAnswer 应答，再查单按 queryAnswer 应答。 */
function routes(closeAnswer: ReturnType<Route>, queryAnswer: ReturnType<Route>): Route {
  return (request) => (isClose(request) ? closeAnswer : queryAnswer);
}

const CLOSED = wxAnswer(204, '');

it('[AC-B2-15k#301] 关单请求：POST .../out-trade-no/{单号}/close，正文只有 mchid，APIv3 签名', async () => {
  const h = wechatChannel(routes(CLOSED, wxAnswer(200, wxTrade({ trade_state: 'CLOSED' }))));
  okOf(await h.channel.close(OUT));
  const request = h.calls[0]!;
  expect(request.method).toBe('POST');
  expect(request.url).toBe(
    `https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/${OUT}/close`,
  );
  expect(JSON.parse(request.body ?? '{}')).toEqual({ mchid: MCHID });
  expectWxSigned(request);
});

it.each([
  ['CLOSED', wxAnswer(200, wxTrade({ trade_state: 'CLOSED' })), 'closed'],
  ['SUCCESS', wxAnswer(200, wxTrade()), 'paid'],
  ['404 ORDER_NOT_EXIST', wxAnswer(404, { code: 'ORDER_NOT_EXIST' }), 'not_exist'],
])(
  '[AC-B2-15k#302] 204 之后必须再查一次单，结果由查单决定：%s → %s',
  async (_name, query, state) => {
    const h = wechatChannel(routes(CLOSED, query));
    expect(okOf(await h.channel.close(OUT)).state).toBe(state);
    expect(h.calls).toHaveLength(2);
    expect(isClose(h.calls[0]!)).toBe(true);
    expect(h.calls[1]!.method).toBe('GET');
    expect(h.calls[1]!.url).toContain(`/v3/pay/transactions/out-trade-no/${OUT}?mchid=${MCHID}`);
  },
);

it.each([
  ['NOTPAY', wxAnswer(200, wxTrade({ trade_state: 'NOTPAY' }))],
  ['USERPAYING', wxAnswer(200, wxTrade({ trade_state: 'USERPAYING' }))],
  ['REFUND', wxAnswer(200, wxTrade({ trade_state: 'REFUND' }))],
  ['单号不符', wxAnswer(200, wxTrade({ out_trade_no: 'P-OTHER', trade_state: 'CLOSED' }))],
  ['商户号不符', wxAnswer(200, wxTrade({ mchid: '1900000000', trade_state: 'CLOSED' }))],
  [
    '查单验签不过',
    wxAnswer(200, wxTrade({ trade_state: 'CLOSED' }), { serial: 'PUB_KEY_ID_OTHER' }),
  ],
  ['查单 HTTP 500', wxAnswer(500, { code: 'SYSTEM_ERROR' })],
])(
  '[AC-B2-15k#303] 204 之后查单不是已关闭、已支付、查无此单（%s）：unknown，204 本身不算关闭',
  async (_name, query) => {
    const h = wechatChannel(routes(CLOSED, query));
    expectUnknown(await h.channel.close(OUT));
  },
);

it('[AC-B2-15k#304] 204 之后查单 transport 抛异常：unknown', async () => {
  const h = wechatChannel((request) => {
    if (isClose(request)) return CLOSED;
    throw new Error('boom');
  });
  expectUnknown(await h.channel.close(OUT));
});

it('[AC-B2-15k#305] 204 的验签串是 时间戳\\n随机串\\n\\n：少了空正文那一行的签名是错的，unknown', async () => {
  const twoLines = createSign('RSA-SHA256')
    .update(`${String(NOW_S)}\nresp-nonce\n`, 'utf8')
    .sign(WECHAT_PLATFORM.privateKey, 'base64');
  const h = wechatChannel(
    routes(
      wxAnswer(204, '', { signature: twoLines }),
      wxAnswer(200, wxTrade({ trade_state: 'CLOSED' })),
    ),
  );
  expectUnknown(await h.channel.close(OUT));
});

const CLOSE_FAULTS: [string, PayHttpResponse][] = [
  ['缺签名', { status: 204, headers: {}, body: '' }],
  ['序列号不符', wxAnswer(204, '', { serial: 'PUB_KEY_ID_OTHER' })],
  ['超时间窗', wxAnswer(204, '', { at: NOW_S - 300 })],
  ['HTTP 200 而不是 204', wxAnswer(200, '{}')],
  ['204 却有正文', wxAnswer(204, '{"status":"CLOSED"}')],
  ['HTTP 302', wxAnswer(302, '')],
  // 没有验过签的错误应答、串单的错误应答：不是「验过签的业务错误」，不再查。
  ['错误应答缺签名', { status: 400, headers: {}, body: '{"code":"INVALID_REQUEST"}' }],
  ['错误应答别的私钥签的', wxAnswer(400, { code: 'INVALID_REQUEST' }, { key: OTHER.privateKey })],
  ['错误应答序列号不符', wxAnswer(403, { code: 'TRADE_ERROR' }, { serial: 'PUB_KEY_ID_OTHER' })],
  ['错误应答超时间窗', wxAnswer(500, { code: 'SYSTEM_ERROR' }, { at: NOW_S - 300 })],
  ['错误应答不是 JSON', wxAnswer(400, 'not json')],
  ['错误应答没有错误码', wxAnswer(400, { message: 'message' })],
  ['错误应答的错误码是数字', wxAnswer(400, { code: 400 })],
  ['串单：错误应答带别的单号', wxAnswer(403, { code: 'TRADE_ERROR', out_trade_no: 'P-OTHER' })],
  ['串单：错误应答带别的商户号', wxAnswer(403, { code: 'TRADE_ERROR', mchid: '1900000000' })],
  ['串单：错误应答带别的应用', wxAnswer(403, { code: 'TRADE_ERROR', appid: 'wx-other' })],
];

it.each(CLOSE_FAULTS)(
  '[AC-B2-15k#306] 关单应答不可信（%s）：一律 unknown，不因为接着查到已关闭就算关闭',
  async (_name, answer) => {
    const h = wechatChannel(routes(answer, wxAnswer(200, wxTrade({ trade_state: 'CLOSED' }))));
    expectUnknown(await h.channel.close(OUT));
  },
);

it('[AC-B2-15k#307] 关单 transport 抛异常：unknown，不抛', async () => {
  const h = wechatChannel(() => {
    throw new Error('boom');
  });
  expectUnknown(await h.channel.close(OUT));
});

// 任务书第 13 节裁定：验过签的关单业务错误也要再查一次单，以查询结果定 closed / paid / not_exist；查询也拿不到结果才 unknown。
// 4013070360.txt:285-344 写明的错误码。
const CLOSE_ERRORS: [number, string][] = [
  [400, 'PARAM_ERROR'],
  [400, 'INVALID_REQUEST'],
  [400, 'MCH_NOT_EXISTS'],
  [401, 'SIGN_ERROR'],
  [403, 'RULE_LIMIT'],
  [403, 'TRADE_ERROR'],
  [429, 'FREQUENCY_LIMITED'],
  [500, 'SYSTEM_ERROR'],
];

it.each(CLOSE_ERRORS)(
  '[AC-B2-15k#308] 验过签的关单错误 %s %s，而单仍是 NOTPAY：再查一次，不凭错误码下结论，unknown',
  async (status, code) => {
    const h = wechatChannel(
      routes(wxAnswer(status, { code }), wxAnswer(200, wxTrade({ trade_state: 'NOTPAY' }))),
    );
    expectUnknown(await h.channel.close(OUT));
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.method).toBe('GET');
  },
);

const QUERY_DECIDES: [string, PayHttpResponse, string][] = [
  ['CLOSED', wxAnswer(200, wxTrade({ trade_state: 'CLOSED' })), 'closed'],
  ['SUCCESS', wxAnswer(200, wxTrade()), 'paid'],
  ['404 ORDER_NOT_EXIST', wxAnswer(404, { code: 'ORDER_NOT_EXIST' }), 'not_exist'],
];

const ERROR_THEN_QUERY = CLOSE_ERRORS.flatMap(([status, code]) =>
  QUERY_DECIDES.map(([name, query, state]) => [status, code, name, state, query] as const),
);

it.each(ERROR_THEN_QUERY)(
  '[AC-B2-15k#309] 验过签的关单错误 %s %s 之后再查一次单：查到 %s → %s',
  async (status, code, _name, state, query) => {
    const h = wechatChannel(routes(wxAnswer(status, { code }), query));
    expect(okOf(await h.channel.close(OUT)).state).toBe(state);
    expect(h.calls).toHaveLength(2);
    expect(isClose(h.calls[0]!)).toBe(true);
    expect(h.calls[1]!.method).toBe('GET');
  },
);

const TRADE_ERROR = wxAnswer(403, { code: 'TRADE_ERROR' });

it.each([
  ['查单 HTTP 500', wxAnswer(500, { code: 'SYSTEM_ERROR' })],
  ['查单单号不符', wxAnswer(200, wxTrade({ out_trade_no: 'P-OTHER', trade_state: 'CLOSED' }))],
  [
    '查单验签不过',
    wxAnswer(200, wxTrade({ trade_state: 'CLOSED' }), { serial: 'PUB_KEY_ID_OTHER' }),
  ],
])('[AC-B2-15k#310] 验过签的关单错误之后查单也拿不到结果（%s）：unknown', async (_name, query) => {
  const h = wechatChannel(routes(TRADE_ERROR, query));
  expectUnknown(await h.channel.close(OUT));
  expect(h.calls).toHaveLength(2);
});

it('[AC-B2-15k#311] 验过签的关单错误之后查单 transport 抛异常：unknown，不抛', async () => {
  const h = wechatChannel((request) => {
    if (isClose(request)) return TRADE_ERROR;
    throw new Error('boom');
  });
  expectUnknown(await h.channel.close(OUT));
});
