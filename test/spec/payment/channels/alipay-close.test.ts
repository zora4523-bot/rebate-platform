// B2-15k 支付宝关单（claude-independent，SPEC_REF deb521c2）：08 BR-PAY-05 ②（先查后关）、BR-PAY-04 细则
// （TRADE_FINISHED）；任务书 9.3：10000 不算关闭成功，必须再查一次单；r3 必须改 ③（已签名的查询应答换外层键冒充关单）。
// 出处：docs-mirror/alipay/app-pay/02e7gn.md（业务响应 253、错误码 287-294）、02e7gm.md。未实测（BR-PAY-09）。
import { expect, it } from 'vitest';
import type { PayHttpResponse } from '../../../../apps/api/src/modules/payment/infra/channels/transport.ts';
import {
  CLOSE_NODE,
  OUT,
  QUERY_NODE,
  TRADE_NO,
  aliAnswer,
  aliBiz,
  aliError,
  aliEnvelopeFaults,
  aliMethod,
  aliParams,
  aliTrade,
  alipayChannel,
  expectAliSigned,
  expectUnknown,
  okOf,
  rawAnswer,
  type Route,
} from './kit.ts';

const CLOSE_OK = aliAnswer(CLOSE_NODE, {
  code: '10000',
  msg: 'Success',
  trade_no: TRADE_NO,
  out_trade_no: OUT,
});

function routes(close: PayHttpResponse, query: PayHttpResponse): Route {
  return (request) => (aliMethod(request) === 'alipay.trade.close' ? close : query);
}

const QUERY_CLOSED = aliAnswer(QUERY_NODE, aliTrade({ trade_status: 'TRADE_CLOSED' }));

it('[AC-B2-15k#801] 关单请求：alipay.trade.close，biz_content 只带 out_trade_no，RSA2 签名', async () => {
  const h = alipayChannel(routes(CLOSE_OK, QUERY_CLOSED));
  okOf(await h.channel.close(OUT));
  const request = h.calls[0]!;
  expect(aliMethod(request)).toBe('alipay.trade.close');
  expect(aliBiz(request)).toEqual({ out_trade_no: OUT });
  expectAliSigned(aliParams(request));
});

it.each([
  ['TRADE_CLOSED', QUERY_CLOSED, 'closed'],
  ['TRADE_SUCCESS', aliAnswer(QUERY_NODE, aliTrade()), 'paid'],
  [
    '40004 ACQ.TRADE_NOT_EXIST',
    aliAnswer(QUERY_NODE, aliError('40004', 'ACQ.TRADE_NOT_EXIST')),
    'not_exist',
  ],
])(
  '[AC-B2-15k#802] 10000 之后必须再查一次单，结果由查单决定：%s → %s',
  async (_name, query, state) => {
    const h = alipayChannel(routes(CLOSE_OK, query));
    expect(okOf(await h.channel.close(OUT)).state).toBe(state);
    expect(h.calls.map(aliMethod)).toEqual(['alipay.trade.close', 'alipay.trade.query']);
  },
);

it.each([
  ['WAIT_BUYER_PAY', aliAnswer(QUERY_NODE, aliTrade({ trade_status: 'WAIT_BUYER_PAY' }))],
  [
    'TRADE_FINISHED（实测前不算已支付）',
    aliAnswer(QUERY_NODE, aliTrade({ trade_status: 'TRADE_FINISHED' })),
  ],
  [
    '查单单号不符',
    aliAnswer(QUERY_NODE, aliTrade({ out_trade_no: 'P-OTHER', trade_status: 'TRADE_CLOSED' })),
  ],
  ['查单是系统错误', aliAnswer(QUERY_NODE, aliError('20000', 'isp.unknow-error'))],
  ['查单 HTTP 500', rawAnswer('', 500)],
])(
  '[AC-B2-15k#803] 10000 之后查单不是已关闭、已支付、查无此单（%s）：unknown，10000 本身不算关闭',
  async (_name, query) => {
    const h = alipayChannel(routes(CLOSE_OK, query));
    expectUnknown(await h.channel.close(OUT));
  },
);

it('[AC-B2-15k#804] r3 必须改 ③：把已签名的查询成功节点换外层键冒充关单应答：不直接算关闭，查单未关就是 unknown', async () => {
  const swapped = aliAnswer(CLOSE_NODE, aliTrade({ trade_status: 'TRADE_CLOSED' }));
  const h = alipayChannel(
    routes(swapped, aliAnswer(QUERY_NODE, aliTrade({ trade_status: 'WAIT_BUYER_PAY' }))),
  );
  expectUnknown(await h.channel.close(OUT));
});

it('[AC-B2-15k#805] 查单时收到换了外层键的节点（接口键被换）：unknown', async () => {
  const h = alipayChannel(
    routes(CLOSE_OK, aliAnswer(CLOSE_NODE, aliTrade({ trade_status: 'TRADE_CLOSED' }))),
  );
  expectUnknown(await h.channel.close(OUT));
});

it.each(
  aliEnvelopeFaults(CLOSE_NODE, {
    code: '10000',
    msg: 'Success',
    trade_no: TRADE_NO,
    out_trade_no: OUT,
  }),
)(
  '[AC-B2-15k#806] 关单应答外壳不可信（%s）：一律 unknown，不因为接着查到已关闭就算关闭',
  async (_name, answer) => {
    const h = alipayChannel(routes(answer, QUERY_CLOSED));
    expectUnknown(await h.channel.close(OUT));
  },
);

it('[AC-B2-15k#807] 关单应答回显的单号与请求不符：unknown，不因为接着查到已关闭就算关闭', async () => {
  const other = aliAnswer(CLOSE_NODE, { code: '10000', msg: 'Success', out_trade_no: 'P-OTHER' });
  const h = alipayChannel(routes(other, QUERY_CLOSED));
  expectUnknown(await h.channel.close(OUT));
});

it.each([
  ['ACQ.TRADE_STATUS_ERROR', aliError('40004', 'ACQ.TRADE_STATUS_ERROR')],
  ['ACQ.REASON_ILLEGAL_STATUS', aliError('40004', 'ACQ.REASON_ILLEGAL_STATUS')],
  ['ACQ.SYSTEM_ERROR', aliError('40004', 'ACQ.SYSTEM_ERROR')],
  ['ACQ.TRADE_NOT_EXIST', aliError('40004', 'ACQ.TRADE_NOT_EXIST')],
  ['isp.unknow-error', aliError('20000', 'isp.unknow-error')],
])(
  '[AC-B2-15k#808] 验过签的关单错误 %s，而单仍是待支付：不凭错误码下结论，unknown',
  async (_name, node) => {
    const h = alipayChannel(
      routes(
        aliAnswer(CLOSE_NODE, node),
        aliAnswer(QUERY_NODE, aliTrade({ trade_status: 'WAIT_BUYER_PAY' })),
      ),
    );
    expectUnknown(await h.channel.close(OUT));
  },
);

it('[AC-B2-15k#809] 关单 transport 抛异常：unknown，不抛', async () => {
  const h = alipayChannel(() => {
    throw new Error('boom');
  });
  expectUnknown(await h.channel.close(OUT));
});
