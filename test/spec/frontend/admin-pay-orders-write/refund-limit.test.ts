// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ORDER,
  OUT_TRADE_NO,
  REFUNDABLE,
  VIEW_REFUND_GRANTS,
  createServer,
  newOutRefundNo,
  refundPath,
  rejected,
  type Server,
} from './fixtures.ts';
import {
  ACCEPTED,
  FLOW_TIMEOUT,
  LABEL,
  assertRefund,
  fieldError,
  fill,
  fillRefund,
  freshText,
  main,
  openDetail,
  openRefund,
  permitWrites,
  refundDialogs,
  refundableShown,
  rowsOf,
  settle,
  settled,
  snapshotText,
  submitRefund,
  textbox,
} from './helpers.ts';

/** A pay.view + pay.refund server that may receive refunds of the pay order `payOrderId` only. */
function refundServer(payOrderId: string): Server {
  const server = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
  permitWrites(server, ['POST', refundPath(payOrderId)]);
  return server;
}

it.each([
  {
    name: '部分退款的已支付单（12800 − 已成功 3050 − 退款中 1500，失败的 2000 不占额）',
    id: ORDER.refunded,
    outTradeNo: OUT_TRADE_NO.refunded,
    limit: REFUNDABLE.refunded,
  },
  {
    name: '未退款的已支付单（2500）',
    id: ORDER.paid,
    outTradeNo: OUT_TRADE_NO.paid,
    limit: REFUNDABLE.paid,
  },
] as const)(
  '[AC-F1-13b-LIMIT#1] $name：可退金额若显示须等于手算值；比可退多 1 分时在金额旁提示（前端预检不发，或发出后收 20001 [amount_fen]），不受理、不出新退款记录；改成恰好可退金额后照常提交',
  async ({ id, outTradeNo, limit }) => {
    const server = refundServer(id);
    await openDetail(server, id, outTradeNo);
    const modal = await openRefund();
    for (const shown of refundableShown(modal)) expect(shown).toBe(limit.yuan);

    await fillRefund(modal, { amount: limit.over, reason: 'USER_REQUEST' });
    await submitRefund(modal);
    await settled(server);
    await waitFor(() => expect(fieldError(textbox(modal, LABEL.amount))).not.toBe(''));
    expect(server.refunds(id).length, 'at most the one refused request').toBeLessThanOrEqual(1);
    expect(rowsOf(main(), newOutRefundNo(1))).toEqual([]);
    expect(refundDialogs()).toHaveLength(1);
    const refused = server.refunds(id).length;

    await fill(textbox(modal, LABEL.amount), limit.yuan);
    await submitRefund(modal);
    await waitFor(() => expect(server.refunds(id)).toHaveLength(refused + 1));
    await settled(server);
    assertRefund(server.refunds(id).at(-1)!, limit.fen, 'USER_REQUEST');
    await waitFor(() => expect(rowsOf(main(), newOutRefundNo(1))).toHaveLength(1));
    expect(server.refundReads()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-LIMIT#2] 前端看来未超额、服务端仍回 20001 data.fields=[amount_fen]（他人刚退过）：请求照发一次，在金额旁提示，对话框不关、不提示受理',
  async () => {
    const server = refundServer(ORDER.paid);
    server.once('POST', refundPath(ORDER.paid), () => rejected(['amount_fen']));
    await openDetail(server, ORDER.paid, OUT_TRADE_NO.paid);
    const modal = await openRefund();
    await fillRefund(modal, { amount: '10.00', reason: 'RECON_DIFF' });
    await submitRefund(modal);
    await waitFor(() => expect(server.refunds(ORDER.paid)).toHaveLength(1));
    await settled(server);
    assertRefund(server.refunds(ORDER.paid)[0]!, 1000, 'RECON_DIFF');
    await waitFor(() => expect(fieldError(textbox(modal, LABEL.amount))).not.toBe(''));
    expect(refundDialogs()).toHaveLength(1);
    expect(rowsOf(main(), newOutRefundNo(1))).toEqual([]);
    expect(server.refunds(ORDER.paid)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it.each([
  { typed: '0' },
  { typed: '0.00' },
  { typed: '-5' },
  { typed: '0.001' },
  { typed: '12.345' },
  { typed: 'abc' },
  { typed: '' },
] as const)(
  '[AC-F1-13b-LIMIT#3] 金额「$typed」（≤ 0、不足一分、不是数或为空）：在金额旁提示（前端拦下不发，或发出后收 20001 [amount_fen]——不得按正整数分发出），对话框不关、不受理、不出新退款记录',
  async ({ typed }) => {
    const server = refundServer(ORDER.refunded);
    await openDetail(server, ORDER.refunded, OUT_TRADE_NO.refunded);
    const modal = await openRefund();
    await fillRefund(modal, { amount: typed, reason: 'USER_REQUEST' });
    const before = snapshotText();
    await submitRefund(modal);
    await settled(server);
    await waitFor(() => expect(fieldError(textbox(modal, LABEL.amount))).not.toBe(''));
    await settle();
    await settled(server);
    const sent = server.refunds();
    expect(sent.length, 'at most the one refused request').toBeLessThanOrEqual(1);
    for (const request of sent) {
      // Sent at all, it carries no positive whole fen: the server refuses it with 20001.
      const amount = (request.body as Record<string, unknown> | undefined)?.['amount_fen'];
      expect(
        typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 1,
        `「${typed}」 is not sent as a positive amount_fen (${String(amount)})`,
      ).toBe(false);
    }
    expect(refundDialogs()).toHaveLength(1);
    expect(rowsOf(main(), newOutRefundNo(1))).toEqual([]);
    expect(freshText(before)).not.toMatch(ACCEPTED);
  },
  FLOW_TIMEOUT,
);
