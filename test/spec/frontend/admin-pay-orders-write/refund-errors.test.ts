// @vitest-environment jsdom
import { act, fireEvent, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ORDER,
  OUT_TRADE_NO,
  VIEW_REFUND_GRANTS,
  changedBody,
  conflict,
  createServer,
  inProgress,
  networkDown,
  newOutRefundNo,
  refundPath,
  rejected,
} from './fixtures.ts';
import {
  ACCEPTED,
  CANCEL,
  CHANGED,
  CONFLICT,
  FLOW_TIMEOUT,
  NOT_FOUND,
  RUNNING,
  SUBMIT,
  action,
  assertRefund,
  click,
  dismissRefundDialogs,
  fillRefund,
  freshText,
  main,
  openDetail,
  openRefund,
  refundDialog,
  refundDialogs,
  requestKey,
  rowsOf,
  settle,
  settled,
  snapshotText,
  submitRefund,
} from './helpers.ts';

const AMOUNT = { typed: '5.00', fen: 500 } as const;

it(
  '[AC-F1-13b-REFUNDERR#1] 20902（支付单已非已支付）：提示状态已变化并重新读取详情，只发一次 POST',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
    server.once('POST', refundPath(ORDER.paid), conflict);
    await openDetail(server, ORDER.paid, OUT_TRADE_NO.paid);
    const modal = await openRefund();
    await fillRefund(modal, { amount: AMOUNT.typed, reason: 'USER_REQUEST' });
    const reads = server.detailReads(ORDER.paid).length;
    const before = snapshotText();
    await submitRefund(modal);
    await waitFor(() => expect(server.refunds(ORDER.paid)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(before)).toMatch(CONFLICT));
    await waitFor(() =>
      expect(server.detailReads(ORDER.paid).length, 'the detail is read again').toBeGreaterThan(
        reads,
      ),
    );
    await settled(server);
    expect(server.refunds()).toHaveLength(1);
    expect(server.refundReads()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-REFUNDERR#2] 20901（同键不同请求体）：提示请求内容有变化，不自动重发',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
    server.once('POST', refundPath(ORDER.paid), changedBody);
    await openDetail(server, ORDER.paid, OUT_TRADE_NO.paid);
    const modal = await openRefund();
    await fillRefund(modal, { amount: AMOUNT.typed, reason: 'USER_REQUEST' });
    const before = snapshotText();
    await submitRefund(modal);
    await waitFor(() => expect(server.refunds(ORDER.paid)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(before)).toMatch(CHANGED));
    await settle();
    await settled(server);
    expect(server.refunds()).toHaveLength(1);
    expect(rowsOf(main(), newOutRefundNo(1))).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-REFUNDERR#3] 40901（同一请求处理中）：提示稍后查看，不自动重发',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
    server.once('POST', refundPath(ORDER.paid), inProgress);
    await openDetail(server, ORDER.paid, OUT_TRADE_NO.paid);
    const modal = await openRefund();
    await fillRefund(modal, { amount: AMOUNT.typed, reason: 'USER_REQUEST' });
    const before = snapshotText();
    await submitRefund(modal);
    await waitFor(() => expect(server.refunds(ORDER.paid)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(before)).toMatch(RUNNING));
    await settle();
    await settled(server);
    expect(server.refunds()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-REFUNDERR#4] 20001 data.fields=[pay_order_id]（支付单不存在或非本应用）：提示未找到，不提示受理',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
    server.once('POST', refundPath(ORDER.paid), () => rejected(['pay_order_id']));
    await openDetail(server, ORDER.paid, OUT_TRADE_NO.paid);
    const modal = await openRefund();
    await fillRefund(modal, { amount: AMOUNT.typed, reason: 'USER_REQUEST' });
    const before = snapshotText();
    await submitRefund(modal);
    await waitFor(() => expect(server.refunds(ORDER.paid)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(before)).toMatch(NOT_FOUND));
    expect(freshText(before)).not.toMatch(ACCEPTED);
    expect(server.refunds()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-REFUNDERR#5] 网络失败后在同一对话框重试：两次 POST 的 Idempotency-Key 与请求体都相同，重试成功后提示受理并出现新退款记录',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
    server.once('POST', refundPath(ORDER.paid), networkDown);
    await openDetail(server, ORDER.paid, OUT_TRADE_NO.paid);
    const modal = await openRefund();
    await fillRefund(modal, { amount: AMOUNT.typed, reason: 'USER_REQUEST', note: '网络重试' });
    await submitRefund(modal);
    await waitFor(() => expect(server.refunds(ORDER.paid)).toHaveLength(1));
    await settled(server);
    const retry = await refundDialog();
    const before = snapshotText();
    await click(action(retry, SUBMIT));
    await settle();
    await waitFor(() => expect(server.refunds(ORDER.paid)).toHaveLength(2));
    await settled(server);
    const [first, second] = server.refunds(ORDER.paid);
    assertRefund(first!, AMOUNT.fen, 'USER_REQUEST', '网络重试');
    assertRefund(second!, AMOUNT.fen, 'USER_REQUEST', '网络重试');
    expect(requestKey(second!), 'the retry reuses the key').toBe(requestKey(first!));
    expect(second!.body).toEqual(first!.body);
    await waitFor(() => expect(freshText(before)).toMatch(ACCEPTED));
    await waitFor(() => expect(rowsOf(main(), newOutRefundNo(1))).toHaveLength(1));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-REFUNDERR#6] 网络失败后取消、重新打开对话框再提交：用新的 Idempotency-Key',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
    server.once('POST', refundPath(ORDER.paid), networkDown);
    await openDetail(server, ORDER.paid, OUT_TRADE_NO.paid);
    const modal = await openRefund();
    await fillRefund(modal, { amount: AMOUNT.typed, reason: 'USER_REQUEST' });
    await submitRefund(modal);
    await waitFor(() => expect(server.refunds(ORDER.paid)).toHaveLength(1));
    await settled(server);
    await click(action(await refundDialog(), CANCEL));
    await settle();
    await waitFor(() => expect(refundDialogs()).toEqual([]));
    expect(server.refunds(ORDER.paid), 'cancelling sends nothing').toHaveLength(1);

    const again = await openRefund();
    await fillRefund(again, { amount: AMOUNT.typed, reason: 'USER_REQUEST' });
    await submitRefund(again);
    await waitFor(() => expect(server.refunds(ORDER.paid)).toHaveLength(2));
    await settled(server);
    const [first, second] = server.refunds(ORDER.paid);
    assertRefund(second!, AMOUNT.fen, 'USER_REQUEST');
    expect(requestKey(first!)).not.toBeNull();
    expect(requestKey(second!), 'a new dialog uses a new key').not.toBe(requestKey(first!));
    await waitFor(() => expect(rowsOf(main(), newOutRefundNo(1))).toHaveLength(1));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-REFUNDERR#7] 两次各自成功的退款（两个对话框）：两次 Idempotency-Key 不同，退款记录出现两笔',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
    await openDetail(server, ORDER.paid, OUT_TRADE_NO.paid);
    const first = await openRefund();
    await fillRefund(first, { amount: '3.00', reason: 'USER_REQUEST' });
    await submitRefund(first);
    await waitFor(() => expect(server.refunds(ORDER.paid)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(rowsOf(main(), newOutRefundNo(1))).toHaveLength(1));
    await dismissRefundDialogs();

    const second = await openRefund();
    await fillRefund(second, { amount: '4.00', reason: 'OTHER' });
    await submitRefund(second);
    await waitFor(() => expect(server.refunds(ORDER.paid)).toHaveLength(2));
    await settled(server);
    const [one, two] = server.refunds(ORDER.paid);
    assertRefund(one!, 300, 'USER_REQUEST');
    assertRefund(two!, 400, 'OTHER');
    expect(requestKey(two!), 'another refund, another key').not.toBe(requestKey(one!));
    await waitFor(() => expect(rowsOf(main(), newOutRefundNo(2))).toHaveLength(1));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-REFUNDERR#8] 请求在途时再点提交（连点两下）：只发一次 POST',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
    await openDetail(server, ORDER.paid, OUT_TRADE_NO.paid);
    const modal = await openRefund();
    await fillRefund(modal, { amount: AMOUNT.typed, reason: 'USER_REQUEST' });
    const release = server.hold('POST', refundPath(ORDER.paid));
    try {
      const submit = action(modal, SUBMIT);
      await act(async () => {
        fireEvent.click(submit);
        fireEvent.click(submit);
      });
      await settle();
      await waitFor(() => expect(server.refunds(ORDER.paid)).toHaveLength(1));
      await click(submit);
      await settle();
      expect(server.refunds(ORDER.paid)).toHaveLength(1);
    } finally {
      release();
    }
    await settled(server);
    expect(server.refunds(ORDER.paid)).toHaveLength(1);
    await waitFor(() => expect(rowsOf(main(), newOutRefundNo(1))).toHaveLength(1));
  },
  FLOW_TIMEOUT,
);
