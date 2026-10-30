// @vitest-environment jsdom
import { act, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import {
  ORDER,
  OUT_TRADE_NO,
  REFUNDABLE,
  VIEW_REFUND_GRANTS,
  createServer,
  namePattern,
  newOutRefundNo,
  refundPath,
  type Server,
} from './fixtures.ts';
import {
  ACCEPTED,
  FLOW_TIMEOUT,
  LABEL,
  action,
  assertNoStepUp,
  assertRefund,
  chooseReason,
  fieldError,
  fill,
  fillRefund,
  freshText,
  main,
  openDetail,
  openRefund,
  permitWrites,
  reasonControl,
  reasonNames,
  reasonOption,
  refundDialogs,
  refundableShown,
  rowsOf,
  settle,
  settled,
  snapshotText,
  showsYuan,
  submitRefund,
  textOf,
  textbox,
  SUBMIT,
  click,
} from './helpers.ts';

/** A pay.view + pay.refund server that may receive refunds of the pay order `payOrderId` only. */
function refundServer(payOrderId: string): Server {
  const server = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
  permitWrites(server, ['POST', refundPath(payOrderId)]);
  return server;
}

it(
  '[AC-F1-13b-REFUND#1] 部分退款的已支付单【发起退款】：不弹动态码，填 12.34 元、原因「重复支付」与备注提交 POST …/refunds（amount_fen=1234、Idempotency-Key），提示退款已受理 / 退款中，退款记录出现新的一笔（12.34、处理中）；不读退款单列表',
  async () => {
    const server = refundServer(ORDER.refunded);
    await openDetail(server, ORDER.refunded, OUT_TRADE_NO.refunded);
    const modal = await openRefund();
    assertNoStepUp(server);
    for (const shown of refundableShown(modal)) expect(shown).toBe(REFUNDABLE.refunded.yuan);
    expect(server.refunds()).toEqual([]);

    await fillRefund(modal, {
      amount: '12.34',
      reason: 'DUPLICATE_PAYMENT',
      note: '用户重复下单，退回一笔',
    });
    const before = snapshotText();
    await submitRefund(modal);
    await waitFor(() => expect(server.refunds(ORDER.refunded)).toHaveLength(1));
    await settled(server);
    assertRefund(
      server.refunds(ORDER.refunded)[0]!,
      1234,
      'DUPLICATE_PAYMENT',
      '用户重复下单，退回一笔',
    );
    assertNoStepUp(server);
    await waitFor(() => expect(freshText(before)).toMatch(ACCEPTED));
    await waitFor(() => expect(rowsOf(main(), newOutRefundNo(1))).toHaveLength(1));
    const row = rowsOf(main(), newOutRefundNo(1))[0]!;
    expect(showsYuan(textOf(row), '12.34'), `12.34 in 「${textOf(row)}」`).toBe(true);
    expect(textOf(row)).toMatch(namePattern('refundStatus', 'PROCESSING'));
    expect(server.unexpected([['POST', refundPath(ORDER.refunded)]])).toEqual([]);
    expect(server.refundReads()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it.each([
  { typed: '12.34', fen: 1234 },
  { typed: '0.29', fen: 29 },
  { typed: '1.15', fen: 115 },
  { typed: '19.99', fen: 1999 },
  { typed: '0.01', fen: 1 },
  { typed: '82.5', fen: 8250 },
  { typed: '82.50', fen: 8250 },
] as const)(
  '[AC-F1-13b-REFUND#2] 金额按元输入 $typed，按分提交 amount_fen=$fen（手算，不带浮点误差）；不填备注时请求体只有 amount_fen 与 reason_code',
  async ({ typed, fen }) => {
    const server = refundServer(ORDER.refunded);
    await openDetail(server, ORDER.refunded, OUT_TRADE_NO.refunded);
    const modal = await openRefund();
    await fillRefund(modal, { amount: typed, reason: 'USER_REQUEST' });
    await submitRefund(modal);
    await waitFor(() => expect(server.refunds(ORDER.refunded)).toHaveLength(1));
    await settled(server);
    assertRefund(server.refunds(ORDER.refunded)[0]!, fen, 'USER_REQUEST');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-REFUND#3] 原因码选项正好是 pay_refund_reason 的五个值，显示后台字典中文名；选「其他」并填备注提交的 reason_code 为 OTHER、note 原样带上',
  async () => {
    const server = refundServer(ORDER.paid);
    await openDetail(server, ORDER.paid, OUT_TRADE_NO.paid);
    const modal = await openRefund();
    await fill(textbox(modal, LABEL.amount), '1.00');
    const offered = await chooseReason(modal, reasonOption('OTHER'));
    expect([...offered].sort()).toEqual(reasonNames().sort());
    // 「其他」 may require a note (the design does) or not: a note is given either way.
    await fill(textbox(modal, LABEL.note), '对账核实后退回差额');
    await settle();
    await submitRefund(modal);
    await waitFor(() => expect(server.refunds(ORDER.paid)).toHaveLength(1));
    assertRefund(server.refunds(ORDER.paid)[0]!, 100, 'OTHER', '对账核实后退回差额');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-REFUND#4] 不选原因直接提交：不发请求，在原因旁提示，对话框不关；选了原因再提交才发一次',
  async () => {
    const server = refundServer(ORDER.paid);
    await openDetail(server, ORDER.paid, OUT_TRADE_NO.paid);
    const modal = await openRefund();
    await fillRefund(modal, { amount: '5.00' });
    await submitRefund(modal);
    await settled(server);
    await waitFor(() => expect(fieldError(reasonControl(modal))).not.toBe(''));
    expect(server.refunds()).toEqual([]);
    expect(refundDialogs()).toHaveLength(1);

    await chooseReason(modal, reasonOption('USER_REQUEST'));
    await settle();
    await submitRefund(modal);
    await waitFor(() => expect(server.refunds(ORDER.paid)).toHaveLength(1));
    await settled(server);
    assertRefund(server.refunds(ORDER.paid)[0]!, 500, 'USER_REQUEST');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-REFUND#5] 备注最多 200 字：输入 201 字时限制输入或提示修正，不能原样发出；200 字的备注原样提交',
  async () => {
    const server = refundServer(ORDER.paid);
    await openDetail(server, ORDER.paid, OUT_TRADE_NO.paid);
    const modal = await openRefund();
    await fillRefund(modal, { amount: '2.00', reason: 'USER_REQUEST' });
    const note = textbox(modal, LABEL.note);
    const allowed = '退'.repeat(200);
    const user = userEvent.setup({ delay: null });
    // Real typing respects a native maxLength; fireEvent.change alone would bypass it in jsdom.
    await act(async () => {
      await user.clear(note);
      await user.type(note, `${allowed}款`);
    });
    if (note.value.length > 200) {
      await click(action(modal, SUBMIT));
      await settle();
      await settled(server);
      await waitFor(() => expect(fieldError(note)).not.toBe(''));
      expect(server.refunds()).toEqual([]);
      await act(async () => {
        await user.clear(note);
        await user.type(note, allowed);
      });
    }
    expect(note.value).toBe(allowed);
    await submitRefund(modal);
    await waitFor(() => expect(server.refunds(ORDER.paid)).toHaveLength(1));
    assertRefund(server.refunds(ORDER.paid)[0]!, 200, 'USER_REQUEST', allowed);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-REFUND#6] 选「其他」不填备注提交：照常发出（请求体无 note），或不发请求、在备注旁提示且对话框不关、补上备注后才发一次——两种都接受；最终只有一次 POST 并出现新退款记录',
  async () => {
    const server = refundServer(ORDER.paid);
    await openDetail(server, ORDER.paid, OUT_TRADE_NO.paid);
    const modal = await openRefund();
    await fillRefund(modal, { amount: '1.00', reason: 'OTHER' });
    await submitRefund(modal);
    // Either the request goes out, or the note is asked for: wait for whichever happens.
    await waitFor(() =>
      expect(
        server.refunds(ORDER.paid).length > 0 || fieldError(textbox(modal, LABEL.note)) !== '',
        'sent, or a note asked for beside the note field',
      ).toBe(true),
    );
    await settled(server);
    if (server.refunds(ORDER.paid).length === 0) {
      expect(refundDialogs()).toHaveLength(1);
      await fill(textbox(modal, LABEL.note), '其他原因，已与用户确认');
      await settle();
      await submitRefund(modal);
      await waitFor(() => expect(server.refunds(ORDER.paid)).toHaveLength(1));
      await settled(server);
      assertRefund(server.refunds(ORDER.paid)[0]!, 100, 'OTHER', '其他原因，已与用户确认');
    } else {
      assertRefund(server.refunds(ORDER.paid)[0]!, 100, 'OTHER');
    }
    expect(server.refunds()).toHaveLength(1);
    await waitFor(() => expect(rowsOf(main(), newOutRefundNo(1))).toHaveLength(1));
  },
  FLOW_TIMEOUT,
);
