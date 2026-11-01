// B2-15k 微信通知（claude-independent，SPEC_REF deb521c2）：08 BR-PAY-04（通知应答表）、BR-PAY-08 ③；任务书 9.5：
// 校验四个头，序列号等于配置的公钥 ID，时间窗 ±300 秒（±299 接受，±300 拒绝），再 AES-256-GCM 解密；notifyId 取
// 外层 id；按 event_type 分支付与退款；任何不合格都是 rejected，reason 只能是固定常量。
// 出处：docs-mirror/wechat-pay/pages/4013070368.txt（支付通知）、4013070388.txt（退款通知，解密后没有 appid）、
// 4012071382.txt（解密）、4013053249.txt:74-79（探测流量）。未实测（BR-PAY-09）。
import { expect, it } from 'vitest';
import type { PayRawNotification } from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
import {
  MCHID,
  NOW_S,
  OPENID,
  OTHER,
  OUT,
  OUT_REFUND,
  REFUND_ID,
  TRADE_NO,
  WX_APPID,
  expectRejected,
  okOf,
  textOf,
  wechatChannel,
  without,
  wxHeaders,
  wxNotification,
  wxPayNotification,
  wxRefundNotification,
  wxRefundPlain,
  wxResource,
  wxTrade,
  type Json,
  type WxHeader,
} from './kit.ts';

const TRANSACTION = JSON.stringify(wxTrade());

it('[AC-B2-15k#501] 支付通知：验签、解密后带回 notifyId（外层 id）、单号、交易号、订单总金额、原状态、身份；不含渠道用户标识', async () => {
  const { channel } = wechatChannel();
  const result = okOf(await channel.verifyNotification(wxPayNotification()));
  expect(result).toEqual({
    kind: 'ok',
    notifyId: 'EV-2026110100000001',
    outTradeNo: OUT,
    outRefundNo: null,
    channelTradeNo: TRADE_NO,
    amountFen: 100n,
    state: 'SUCCESS',
    merchantRef: MCHID,
    appRef: WX_APPID,
  });
  expect(textOf(result)).not.toContain(OPENID);
});

it.each(['REFUND.SUCCESS', 'REFUND.ABNORMAL', 'REFUND.CLOSED'])(
  '[AC-B2-15k#502] 退款通知 %s：outRefundNo、refundFen=amount.refund、amountFen=amount.total、state=refund_status、channelRefundNo；文档没有 appid，用本配置值',
  async (eventType) => {
    const { channel } = wechatChannel();
    const raw = wxNotification(
      wxResource(
        JSON.stringify(wxRefundPlain({ refund_status: eventType.slice('REFUND.'.length) })),
        {
          aad: 'refund',
          originalType: 'refund',
        },
      ),
      { event_type: eventType },
    );
    const result = okOf(await channel.verifyNotification(raw));
    expect(result).toEqual({
      kind: 'ok',
      notifyId: 'EV-2026110100000001',
      outTradeNo: OUT,
      outRefundNo: OUT_REFUND,
      channelTradeNo: TRADE_NO,
      amountFen: 100n,
      refundFen: 10n,
      channelRefundNo: REFUND_ID,
      state: eventType.slice('REFUND.'.length),
      merchantRef: MCHID,
      appRef: WX_APPID,
    });
  },
);

it('[AC-B2-15k#503] 验过签但状态不是成功：照常带回（留存与告警在通知处理里，不在适配器）', async () => {
  const { channel } = wechatChannel();
  const result = okOf(
    await channel.verifyNotification(wxPayNotification(wxTrade({ trade_state: 'NOTPAY' }))),
  );
  expect(result.state).toBe('NOTPAY');
});

it.each([
  [1, 1n],
  [99, 99n],
  [100, 100n],
  [101, 101n],
  [2147483648, 2147483648n],
])('[AC-B2-15k#504] 金额边界 total=%s：同值 bigint 分', async (total, fen) => {
  const { channel } = wechatChannel();
  const raw = wxPayNotification(
    wxTrade({ amount: { total, payer_total: total, currency: 'CNY' } }),
  );
  expect(okOf(await channel.verifyNotification(raw)).amountFen).toBe(fen);
});

// BR-PAY-04 细则「金额核对用渠道返回的订单总金额」。用代金券时用户实付小于总金额（4013070368.txt 的 amount.total、
// amount.payer_total）：取错字段，已付款的单会判金额不符、不迁移。
it('[AC-B2-15k#512] 用代金券的支付通知 total=100、payer_total=90：amountFen 取订单总金额 100，不取用户实付', async () => {
  const { channel } = wechatChannel();
  const raw = wxPayNotification(
    wxTrade({ amount: { total: 100, payer_total: 90, currency: 'CNY', payer_currency: 'CNY' } }),
  );
  expect(okOf(await channel.verifyNotification(raw)).amountFen).toBe(100n);
});

it('[AC-B2-15k#513] 用代金券的退款通知 refund=10、payer_refund=8：refundFen 取退款金额 10，amountFen 取 total，不取用户侧金额', async () => {
  const { channel } = wechatChannel();
  const amount = { total: 100, refund: 10, payer_total: 90, payer_refund: 8 };
  const raw = wxRefundNotification(wxRefundPlain({ amount }));
  const result = okOf(await channel.verifyNotification(raw));
  expect(result.refundFen).toBe(10n);
  expect(result.amountFen).toBe(100n);
});

it.each([
  ['早 299 秒', NOW_S - 299],
  ['晚 299 秒', NOW_S + 299],
])('[AC-B2-15k#505] 时间窗边界：%s 接受', async (_name, at) => {
  const { channel } = wechatChannel();
  const raw = wxNotification(wxResource(TRANSACTION), {}, { at });
  okOf(await channel.verifyNotification(raw));
});

const SIGNED = wxPayNotification();

function dropped(name: WxHeader): PayRawNotification {
  const headers: Record<string, string> = { ...SIGNED.headers };
  delete headers[name];
  return { ...SIGNED, headers };
}

const ENVELOPE_FAULTS: [string, PayRawNotification][] = [
  ['缺 Wechatpay-Timestamp', dropped('wechatpay-timestamp')],
  ['缺 Wechatpay-Nonce', dropped('wechatpay-nonce')],
  ['缺 Wechatpay-Signature', dropped('wechatpay-signature')],
  ['缺 Wechatpay-Serial', dropped('wechatpay-serial')],
  [
    '探测签名',
    wxNotification(wxResource(TRANSACTION), {}, { signature: 'WECHATPAY/SIGNTEST/bm90' }),
  ],
  ['签名不对', wxNotification(wxResource(TRANSACTION), {}, { signature: 'bm90LWEtc2lnbmF0dXJl' })],
  ['别的私钥签的', wxNotification(wxResource(TRANSACTION), {}, { key: OTHER.privateKey })],
  [
    '序列号不是配置的公钥 ID',
    wxNotification(wxResource(TRANSACTION), {}, { serial: 'PUB_KEY_ID_OTHER' }),
  ],
  ['早 300 秒', wxNotification(wxResource(TRANSACTION), {}, { at: NOW_S - 300 })],
  ['晚 300 秒', wxNotification(wxResource(TRANSACTION), {}, { at: NOW_S + 300 })],
  ['早 301 秒', wxNotification(wxResource(TRANSACTION), {}, { at: NOW_S - 301 })],
  ['时间戳不是数字', wxNotification(wxResource(TRANSACTION), {}, { timestamp: 'soon' })],
  ['正文被改过', { ...SIGNED, body: `${SIGNED.body} ` }],
];

it.each(ENVELOPE_FAULTS)(
  '[AC-B2-15k#506] 通知信封不合格（%s）：rejected，reason 是固定常量',
  async (_name, raw) => {
    const { channel } = wechatChannel();
    expectRejected(await channel.verifyNotification(raw));
  },
);

function signed(body: string): PayRawNotification {
  return { headers: wxHeaders(body), body };
}

function tamperedCiphertext(): Json {
  const resource = wxResource(TRANSACTION);
  const bytes = Buffer.from(resource['ciphertext'] as string, 'base64');
  bytes[0] = (bytes[0] ?? 0) ^ 0xff;
  return { ...resource, ciphertext: bytes.toString('base64') };
}

const RESOURCE_FAULTS: [string, PayRawNotification][] = [
  ['不是 JSON', signed('{not json')],
  ['JSON 数组', signed('[]')],
  ['缺 id', signed(JSON.stringify(without(JSON.parse(SIGNED.body) as Json, 'id')))],
  ['id 是数字', wxNotification(wxResource(TRANSACTION), { id: 42 })],
  ['缺 event_type', signed(JSON.stringify(without(JSON.parse(SIGNED.body) as Json, 'event_type')))],
  [
    'event_type 不是支付或退款',
    wxNotification(wxResource(TRANSACTION), { event_type: 'COMPLAINT.CREATE' }),
  ],
  ['缺 resource', signed(JSON.stringify(without(JSON.parse(SIGNED.body) as Json, 'resource')))],
  ['resource 是字符串', wxNotification(wxResource(TRANSACTION), { resource: 'text' })],
  [
    '算法不是 AEAD_AES_256_GCM',
    wxNotification(wxResource(TRANSACTION, { algorithm: 'AEAD_AES_128_GCM' })),
  ],
  ['别的 APIv3 密钥加密', wxNotification(wxResource(TRANSACTION, { key: 'x'.repeat(32) }))],
  ['密文被改', wxNotification(tamperedCiphertext())],
  [
    'associated_data 被改',
    wxNotification({ ...wxResource(TRANSACTION), associated_data: 'other' }),
  ],
  ['nonce 被改', wxNotification({ ...wxResource(TRANSACTION), nonce: 'zzzzzzzzzzzz' })],
  ['密文太短', wxNotification({ ...wxResource(TRANSACTION), ciphertext: 'AAAA' })],
  ['解密后不是 JSON', wxNotification(wxResource('not json'))],
  ['解密后是数组', wxNotification(wxResource('[]'))],
];

it.each(RESOURCE_FAULTS)(
  '[AC-B2-15k#507] 通知内容不合格（%s）：rejected，不抛异常',
  async (_name, raw) => {
    const { channel } = wechatChannel();
    expectRejected(await channel.verifyNotification(raw));
  },
);

const BAD_TRANSACTIONS: [string, Json][] = [
  ['缺 out_trade_no', without(wxTrade(), 'out_trade_no')],
  ['缺 transaction_id', without(wxTrade(), 'transaction_id')],
  ['缺 trade_state', without(wxTrade(), 'trade_state')],
  ['缺 appid', without(wxTrade(), 'appid')],
  ['缺 mchid', without(wxTrade(), 'mchid')],
  ['缺 amount', without(wxTrade(), 'amount')],
  // 这几条都带合法的 payer_total：把 amountFen 取成 payer_total 的实现也要被拒绝。
  ['缺 total、只有 payer_total', wxTrade({ amount: { payer_total: 100, currency: 'CNY' } })],
  ['total 为负', wxTrade({ amount: { total: -1, payer_total: 100, currency: 'CNY' } })],
  ['total 是字符串', wxTrade({ amount: { total: '100', payer_total: 100, currency: 'CNY' } })],
  ['total 是小数', wxTrade({ amount: { total: 1.5, payer_total: 100, currency: 'CNY' } })],
  [
    'total 是对象',
    wxTrade({ amount: { total: { value: 100 }, payer_total: 100, currency: 'CNY' } }),
  ],
  ['状态是对象', wxTrade({ trade_state: { value: 'SUCCESS' } })],
];

it.each(BAD_TRANSACTIONS)(
  '[AC-B2-15k#508] 支付通知明文不合格（%s）：rejected',
  async (_name, trade) => {
    const { channel } = wechatChannel();
    expectRejected(await channel.verifyNotification(wxPayNotification(trade)));
  },
);

const BAD_REFUNDS: [string, Json][] = [
  ['缺 out_refund_no', without(wxRefundPlain(), 'out_refund_no')],
  ['缺 out_trade_no', without(wxRefundPlain(), 'out_trade_no')],
  ['缺 transaction_id', without(wxRefundPlain(), 'transaction_id')],
  ['缺 refund_id', without(wxRefundPlain(), 'refund_id')],
  ['缺 refund_status', without(wxRefundPlain(), 'refund_status')],
  ['缺 mchid', without(wxRefundPlain(), 'mchid')],
  ['缺 amount', without(wxRefundPlain(), 'amount')],
  // 这几条都带合法的 payer_total、payer_refund：取错字段的实现也要被拒绝。
  [
    '缺 amount.refund',
    wxRefundPlain({ amount: { total: 100, payer_total: 100, payer_refund: 10 } }),
  ],
  [
    '缺 amount.total',
    wxRefundPlain({ amount: { refund: 10, payer_total: 100, payer_refund: 10 } }),
  ],
  [
    'amount.refund 为负',
    wxRefundPlain({ amount: { total: 100, refund: -1, payer_total: 100, payer_refund: 10 } }),
  ],
  [
    'amount.refund 是字符串',
    wxRefundPlain({ amount: { total: 100, refund: '10', payer_total: 100, payer_refund: 10 } }),
  ],
];

it.each(BAD_REFUNDS)('[AC-B2-15k#509] 退款通知明文不合格（%s）：rejected', async (_name, plain) => {
  const { channel } = wechatChannel();
  expectRejected(await channel.verifyNotification(wxRefundNotification(plain)));
});

it.each([
  ['别家的商户号', wxPayNotification(wxTrade({ mchid: '1900000000' }))],
  ['别家的应用', wxPayNotification(wxTrade({ appid: 'wx-other' }))],
  ['退款通知别家的商户号', wxRefundNotification(wxRefundPlain({ mchid: '1900000000' }))],
])(
  '[AC-B2-15k#510] 验签通过但身份不是我方的（%s）：适配器拒绝，或带回后 ownerAppOf 为 null',
  async (_name, raw) => {
    const { channel } = wechatChannel();
    const result = await channel.verifyNotification(raw);
    if (result.kind === 'rejected') {
      expectRejected(result);
    } else {
      expect(
        channel.ownerAppOf({ merchantRef: result.merchantRef, appRef: result.appRef }),
      ).toBeNull();
    }
  },
);

it('[AC-B2-15k#511] 拒绝原因不带任何请求内容（BR-PAY-08 ③：不返回任何业务信息）', async () => {
  const { channel } = wechatChannel();
  const raw = wxNotification(wxResource(JSON.stringify(wxTrade({ out_trade_no: 42 }))));
  const result = await channel.verifyNotification(raw);
  expectRejected(result);
  expect(textOf(result)).not.toContain('42');
  expect(textOf(result)).not.toContain(MCHID);
});
