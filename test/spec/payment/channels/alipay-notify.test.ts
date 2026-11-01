// B2-15k 支付宝异步通知（claude-independent，SPEC_REF deb521c2）：08 BR-PAY-04（通知应答表）、BR-PAY-08 ③；任务书 9.5：
// 去掉 sign、sign_type 排序验签；notifyId 取 notify_id；退款通知 outRefundNo 取 out_biz_no，refundFen 取 refund_fee，
// amountFen 取 total_amount；元→分只经 yuanStrToFen；任何不合格都是 rejected，reason 只能是固定常量。
// 出处：docs-mirror/alipay/app-pay/00dn78.md（参数 21-53，验签 110-114，触发时机 163-173）。未实测（BR-PAY-09）。
import { expect, it } from 'vitest';
import type { PayRawNotification } from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
import {
  ALIPAY_APPID,
  BUYER_LOGON,
  OTHER,
  OUT,
  OUT_REFUND,
  SELLER_ID,
  TRADE_NO,
  aliNotification,
  aliPayFields,
  aliRefundFields,
  aliSignContent,
  alipayChannel,
  expectRejected,
  okOf,
  textOf,
} from './kit.ts';

function fieldsWithout(name: string): Record<string, string> {
  const fields = aliPayFields();
  delete fields[name];
  return fields;
}

it('[AC-B2-15k#1001] 支付成功通知：notifyId=notify_id、单号、交易号、金额、原状态、seller_id、app_id；不含买家信息', async () => {
  const { channel } = alipayChannel();
  const result = okOf(await channel.verifyNotification(aliNotification(aliPayFields())));
  expect(result).toEqual({
    kind: 'ok',
    notifyId: 'ac05099524730693a8b330c5ecf72da9786',
    outTradeNo: OUT,
    outRefundNo: null,
    channelTradeNo: TRADE_NO,
    amountFen: 100n,
    state: 'TRADE_SUCCESS',
    merchantRef: SELLER_ID,
    appRef: ALIPAY_APPID,
  });
  expect(textOf(result)).not.toContain(BUYER_LOGON);
});

it('[AC-B2-15k#1002] 退款通知（有 out_biz_no）：outRefundNo=out_biz_no、refundFen=refund_fee、amountFen=total_amount，state 是渠道原状态', async () => {
  const { channel } = alipayChannel();
  const result = okOf(await channel.verifyNotification(aliNotification(aliRefundFields())));
  expect(result.outRefundNo).toBe(OUT_REFUND);
  expect(result.refundFen).toBe(10n);
  expect(result.amountFen).toBe(100n);
  expect(result.outTradeNo).toBe(OUT);
  expect(result.channelTradeNo).toBe(TRADE_NO);
  expect(result.state).toBe('TRADE_SUCCESS');
});

it.each(['TRADE_FINISHED', 'TRADE_CLOSED', 'WAIT_BUYER_PAY'])(
  '[AC-B2-15k#1003] 验过签但状态是 %s：照常带回原状态（是否成功由 success_states 判定，适配器不改写）',
  async (status) => {
    const { channel } = alipayChannel();
    const raw = aliNotification(aliPayFields({ trade_status: status }));
    expect(okOf(await channel.verifyNotification(raw)).state).toBe(status);
  },
);

it.each([
  ['0.01', 1n],
  ['0.99', 99n],
  ['1.00', 100n],
  ['1.01', 101n],
  ['20', 2000n],
  ['21474836.49', 2147483649n],
])(
  '[AC-B2-15k#1004] 金额边界 total_amount=%s → %s 分（文档示例也有不带小数的 20）',
  async (yuan, fen) => {
    const { channel } = alipayChannel();
    const raw = aliNotification(aliPayFields({ total_amount: yuan }));
    expect(okOf(await channel.verifyNotification(raw)).amountFen).toBe(fen);
  },
);

it('[AC-B2-15k#1005] 待验签串对 sign、sign_type 以外的全部参数解码后排序：含中文、空格、加号的值也能过', async () => {
  const { channel } = alipayChannel();
  const raw = aliNotification(aliPayFields({ subject: '凑狸 a+b', passback_params: 'x%3Dy' }));
  okOf(await channel.verifyNotification(raw));
});

const TAMPERED = aliNotification(aliPayFields());

function replaced(from: string, to: string): PayRawNotification {
  return { ...TAMPERED, body: TAMPERED.body.replace(from, to) };
}

const FAULTS: [string, PayRawNotification][] = [
  ['金额被改', replaced('total_amount=1.00', 'total_amount=9.00')],
  ['状态被改', replaced('trade_status=TRADE_SUCCESS', 'trade_status=TRADE_FINISHED')],
  ['多了一个没签名的参数', { ...TAMPERED, body: `${TAMPERED.body}&extra=1` }],
  ['重复参数', { ...TAMPERED, body: `${TAMPERED.body}&trade_status=TRADE_SUCCESS` }],
  ['别的私钥签的', aliNotification(aliPayFields(), { key: OTHER.privateKey })],
  ['缺 sign', { ...TAMPERED, body: TAMPERED.body.replace(/&?sign=[^&]*/, '') }],
  ['空正文', { ...TAMPERED, body: '' }],
  ['不是表单', { ...TAMPERED, body: '{"trade_status":"TRADE_SUCCESS"}' }],
];

it.each(FAULTS)(
  '[AC-B2-15k#1006] 通知验签不过（%s）：rejected，reason 是固定常量',
  async (_name, raw) => {
    const { channel } = alipayChannel();
    expectRejected(await channel.verifyNotification(raw));
  },
);

it('[AC-B2-15k#1013] sign_type=RSA 的 SHA1 签名：我方只接受 RSA2，rejected', async () => {
  const { channel } = alipayChannel();
  const raw = aliNotification(aliPayFields(), { hash: 'RSA-SHA1', signType: 'RSA' });
  expectRejected(await channel.verifyNotification(raw));
});

it.each(['notify_id', 'trade_no', 'app_id', 'out_trade_no', 'trade_status', 'total_amount'])(
  '[AC-B2-15k#1007] 验签通过但缺必填字段 %s：rejected',
  async (name) => {
    const { channel } = alipayChannel();
    expectRejected(await channel.verifyNotification(aliNotification(fieldsWithout(name))));
  },
);

const BAD_PAY_FIELDS: [string, Record<string, string>][] = [
  ['金额为负', { total_amount: '-1.00' }],
  ['金额不是金额', { total_amount: 'NOT_MONEY' }],
  ['金额三位小数', { total_amount: '1.234' }],
  ['金额科学计数', { total_amount: '1e2' }],
  ['金额为空', { total_amount: '' }],
  ['notify_type 不是 trade_status_sync', { notify_type: 'other' }],
];

it.each(BAD_PAY_FIELDS)(
  '[AC-B2-15k#1008] 验签通过但内容不合格（%s）：rejected',
  async (_name, overrides) => {
    const { channel } = alipayChannel();
    expectRejected(await channel.verifyNotification(aliNotification(aliPayFields(overrides))));
  },
);

const BAD_REFUND_FIELDS: [string, Record<string, string>][] = [
  ['refund_fee 为空', { refund_fee: '' }],
  ['refund_fee 为负', { refund_fee: '-0.10' }],
  ['refund_fee 不是金额', { refund_fee: 'NOT_MONEY' }],
  ['refund_fee 三位小数', { refund_fee: '0.101' }],
];

it.each(BAD_REFUND_FIELDS)(
  '[AC-B2-15k#1009] 退款通知 %s：rejected（没有 refundFen 就不是结果）',
  async (_name, overrides) => {
    const { channel } = alipayChannel();
    expectRejected(await channel.verifyNotification(aliNotification(aliRefundFields(overrides))));
  },
);

const FOREIGN_FIELDS: [string, Record<string, string>][] = [
  ['别家的 seller_id', { seller_id: '2088000000000002' }],
  ['别家的 app_id', { app_id: '2021000000000002', auth_app_id: '2021000000000002' }],
];

it.each(FOREIGN_FIELDS)(
  '[AC-B2-15k#1010] 验签通过但身份不是我方的（%s）：适配器拒绝，或带回后 ownerAppOf 为 null',
  async (_name, overrides) => {
    const { channel } = alipayChannel();
    const result = await channel.verifyNotification(aliNotification(aliPayFields(overrides)));
    if (result.kind === 'rejected') {
      expectRejected(result);
    } else {
      expect(
        channel.ownerAppOf({ merchantRef: result.merchantRef, appRef: result.appRef }),
      ).toBeNull();
    }
  },
);

it('[AC-B2-15k#1011] 拒绝原因不带任何请求内容（BR-PAY-08 ③）', async () => {
  const { channel } = alipayChannel();
  const raw = aliNotification(aliPayFields({ total_amount: 'NOT_MONEY' }));
  const result = await channel.verifyNotification(raw);
  expectRejected(result);
  expect(textOf(result)).not.toContain('NOT_MONEY');
  expect(textOf(result)).not.toContain(OUT);
});

it('[AC-B2-15k#1012] 待验签串按文档示例（00dn78.md:112）排序，不含 sign、sign_type；按这个串签的通知能过', async () => {
  // 先钉住 kit 自己的串，防止测试和实现一起错。
  const content = aliSignContent({
    trade_status: 'TRADE_SUCCESS',
    gmt_create: '2015-06-11 22:33:46',
    sign: 'x',
    sign_type: 'RSA2',
    notify_id: '42af7baacd1d3746cf7b56752b91edcj34',
  });
  expect(content).toBe(
    'gmt_create=2015-06-11 22:33:46&notify_id=42af7baacd1d3746cf7b56752b91edcj34&trade_status=TRADE_SUCCESS',
  );
  const { channel } = alipayChannel();
  okOf(await channel.verifyNotification(aliNotification(aliPayFields())));
});
