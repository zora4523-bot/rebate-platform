// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ANOMALY,
  ANOMALY_TRADE_NO,
  REFUNDABLE,
  VIEW_GRANTS,
  VIEW_REFUND_GRANTS,
  anomalyRefundPath,
  changedBody,
  createServer,
  inProgress,
  networkDown,
  rejected,
  type Server,
} from './fixtures.ts';
import {
  ACCEPTED,
  CANCEL,
  CHANGED,
  FLOW_TIMEOUT,
  LABEL,
  NOT_FOUND,
  RUNNING,
  SUBMIT,
  action,
  anomalyRefundEntries,
  assertNoStepUp,
  assertRefund,
  click,
  dismissRefundDialogs,
  fieldError,
  fill,
  fillRefund,
  freshText,
  main,
  mount,
  openAnomalies,
  openAnomalyRefund,
  openDialogs,
  permitWrites,
  pressWrites,
  refundDialog,
  refundDialogs,
  refundableShown,
  reopenAnomalyRefund,
  requestKey,
  settle,
  settled,
  snapshotText,
  submitRefund,
  textbox,
} from './helpers.ts';

/** A pay.view + pay.refund server that may receive refunds of the anomaly `payAnomalyId` only. */
function refundServer(payAnomalyId: string): Server {
  const server = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
  permitWrites(server, ['POST', anomalyRefundPath(payAnomalyId)]);
  return server;
}

it(
  '[AC-F1-13b-ANOMALY#1] 持 pay.refund：异常收款行的【退款】打开原路退款对话框（不弹动态码），可退金额若显示为 9.90；填 9.90、原因「异常收款退回」提交 POST /admin/v1/pay-anomalies/{id}/refunds（amount_fen=990、Idempotency-Key），提示已受理；不发其他写请求、不读退款单列表',
  async () => {
    const server = refundServer(ANOMALY.open);
    await mount(server);
    const row = await openAnomalies(ANOMALY_TRADE_NO.open);
    const modal = await openAnomalyRefund(row);
    assertNoStepUp(server);
    for (const shown of refundableShown(modal)) expect(shown).toBe(REFUNDABLE.anomalyOpen.yuan);
    await fillRefund(modal, { amount: REFUNDABLE.anomalyOpen.yuan, reason: 'ANOMALY_RECEIPT' });
    const before = snapshotText();
    await submitRefund(modal);
    await waitFor(() => expect(server.anomalyRefunds(ANOMALY.open)).toHaveLength(1));
    await settled(server);
    assertRefund(server.anomalyRefunds(ANOMALY.open)[0]!, 990, 'ANOMALY_RECEIPT');
    assertNoStepUp(server);
    await waitFor(() => expect(freshText(before)).toMatch(ACCEPTED));
    expect(server.refunds()).toEqual([]);
    expect(server.unexpected([['POST', anomalyRefundPath(ANOMALY.open)]])).toEqual([]);
    expect(server.refundReads()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-ANOMALY#2] 已部分退回的异常收款（6600 − 已退 1600 = 可退 5000）：50.01 在金额旁提示、不受理；改成 50.00 提交 amount_fen=5000',
  async () => {
    const server = refundServer(ANOMALY.partial);
    await mount(server);
    const row = await openAnomalies(ANOMALY_TRADE_NO.partial);
    const modal = await openAnomalyRefund(row);
    for (const shown of refundableShown(modal)) expect(shown).toBe(REFUNDABLE.anomalyPartial.yuan);
    await fillRefund(modal, { amount: REFUNDABLE.anomalyPartial.over, reason: 'ANOMALY_RECEIPT' });
    await submitRefund(modal);
    await settled(server);
    await waitFor(() => expect(fieldError(textbox(modal, LABEL.amount))).not.toBe(''));
    expect(server.anomalyRefunds(ANOMALY.partial).length).toBeLessThanOrEqual(1);
    expect(refundDialogs()).toHaveLength(1);
    const refused = server.anomalyRefunds(ANOMALY.partial).length;

    await fill(textbox(modal, LABEL.amount), REFUNDABLE.anomalyPartial.yuan);
    await submitRefund(modal);
    await waitFor(() => expect(server.anomalyRefunds(ANOMALY.partial)).toHaveLength(refused + 1));
    await settled(server);
    assertRefund(server.anomalyRefunds(ANOMALY.partial).at(-1)!, 5000, 'ANOMALY_RECEIPT');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-ANOMALY#3] 20001 data.fields=[pay_anomaly_id]（异常收款不存在或非本应用）：提示未找到，不提示受理',
  async () => {
    const server = refundServer(ANOMALY.open);
    server.once('POST', anomalyRefundPath(ANOMALY.open), () => rejected(['pay_anomaly_id']));
    await mount(server);
    const row = await openAnomalies(ANOMALY_TRADE_NO.open);
    const modal = await openAnomalyRefund(row);
    await fillRefund(modal, { amount: '1.00', reason: 'ANOMALY_RECEIPT' });
    const before = snapshotText();
    await submitRefund(modal);
    await waitFor(() => expect(server.anomalyRefunds(ANOMALY.open)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(before)).toMatch(NOT_FOUND));
    expect(freshText(before)).not.toMatch(ACCEPTED);
    expect(server.anomalyRefunds()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-ANOMALY#4] 异常收款退款网络失败后在同一对话框重试：两次 POST 的 Idempotency-Key 相同，重试成功后提示受理',
  async () => {
    const server = refundServer(ANOMALY.open);
    server.once('POST', anomalyRefundPath(ANOMALY.open), networkDown);
    await mount(server);
    const row = await openAnomalies(ANOMALY_TRADE_NO.open);
    const modal = await openAnomalyRefund(row);
    await fillRefund(modal, { amount: '2.00', reason: 'ANOMALY_RECEIPT' });
    await submitRefund(modal);
    await waitFor(() => expect(server.anomalyRefunds(ANOMALY.open)).toHaveLength(1));
    await settled(server);
    const retry = await refundDialog();
    const before = snapshotText();
    await click(action(retry, SUBMIT));
    await settle();
    await waitFor(() => expect(server.anomalyRefunds(ANOMALY.open)).toHaveLength(2));
    await settled(server);
    const [first, second] = server.anomalyRefunds(ANOMALY.open);
    assertRefund(first!, 200, 'ANOMALY_RECEIPT');
    assertRefund(second!, 200, 'ANOMALY_RECEIPT');
    expect(requestKey(second!), 'the retry reuses the key').toBe(requestKey(first!));
    expect(second!.body).toEqual(first!.body);
    await waitFor(() => expect(freshText(before)).toMatch(ACCEPTED));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-ANOMALY#5] 只持 pay.view：异常收款行（及其详情）没有可用的【退款】，按了也不发 POST；换成持 pay.view + pay.refund 的账号则有',
  async () => {
    const viewer = createServer(undefined, { permissions: VIEW_GRANTS });
    await mount(viewer);
    const row = await openAnomalies(ANOMALY_TRADE_NO.open);
    expect(await anomalyRefundEntries(row), 'no usable 【退款】 for pay.view').toEqual([]);
    await pressWrites(main());
    for (const node of openDialogs()) await pressWrites(node);
    await settled(viewer);
    expect(viewer.writes()).toEqual([]);
    assertNoStepUp(viewer);
    cleanup();

    const refunder = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
    await mount(refunder);
    const allowed = await openAnomalies(ANOMALY_TRADE_NO.open);
    expect((await anomalyRefundEntries(allowed)).length).toBeGreaterThan(0);
    await settled(refunder);
    expect(refunder.writes()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-ANOMALY#6] 异常收款退款网络失败后取消、重新打开对话框再提交：用新的 Idempotency-Key，提交成功后提示受理',
  async () => {
    const server = refundServer(ANOMALY.open);
    server.once('POST', anomalyRefundPath(ANOMALY.open), networkDown);
    await mount(server);
    const row = await openAnomalies(ANOMALY_TRADE_NO.open);
    const modal = await openAnomalyRefund(row);
    await fillRefund(modal, { amount: '2.00', reason: 'ANOMALY_RECEIPT' });
    await submitRefund(modal);
    await waitFor(() => expect(server.anomalyRefunds(ANOMALY.open)).toHaveLength(1));
    await settled(server);
    await click(action(await refundDialog(), CANCEL));
    await settle();
    await waitFor(() => expect(refundDialogs()).toEqual([]));
    expect(server.anomalyRefunds(ANOMALY.open), 'cancelling sends nothing').toHaveLength(1);

    const again = await reopenAnomalyRefund(ANOMALY_TRADE_NO.open);
    await fillRefund(again, { amount: '2.00', reason: 'ANOMALY_RECEIPT' });
    const before = snapshotText();
    await submitRefund(again);
    await waitFor(() => expect(server.anomalyRefunds(ANOMALY.open)).toHaveLength(2));
    await settled(server);
    const [first, second] = server.anomalyRefunds(ANOMALY.open);
    assertRefund(first!, 200, 'ANOMALY_RECEIPT');
    assertRefund(second!, 200, 'ANOMALY_RECEIPT');
    expect(requestKey(second!), 'a new dialog uses a new key').not.toBe(requestKey(first!));
    await waitFor(() => expect(freshText(before)).toMatch(ACCEPTED));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-ANOMALY#7] 同一条异常收款两次各自成功的退款（两个对话框，3.00 与 4.00）：两次 Idempotency-Key 不同，各提示受理',
  async () => {
    const server = refundServer(ANOMALY.open);
    await mount(server);
    const first = await openAnomalyRefund(await openAnomalies(ANOMALY_TRADE_NO.open));
    await fillRefund(first, { amount: '3.00', reason: 'ANOMALY_RECEIPT' });
    const once = snapshotText();
    await submitRefund(first);
    await waitFor(() => expect(server.anomalyRefunds(ANOMALY.open)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(once)).toMatch(ACCEPTED));
    await dismissRefundDialogs();

    const second = await reopenAnomalyRefund(ANOMALY_TRADE_NO.open);
    await fillRefund(second, { amount: '4.00', reason: 'ANOMALY_RECEIPT' });
    const twice = snapshotText();
    await submitRefund(second);
    await waitFor(() => expect(server.anomalyRefunds(ANOMALY.open)).toHaveLength(2));
    await settled(server);
    const [one, two] = server.anomalyRefunds(ANOMALY.open);
    assertRefund(one!, 300, 'ANOMALY_RECEIPT');
    assertRefund(two!, 400, 'ANOMALY_RECEIPT');
    expect(requestKey(two!), 'another refund, another key').not.toBe(requestKey(one!));
    await waitFor(() => expect(freshText(twice)).toMatch(ACCEPTED));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-ANOMALY#8] 异常收款退款收 20901（同键不同请求体）：提示请求内容有变化，不自动重发',
  async () => {
    const server = refundServer(ANOMALY.open);
    server.once('POST', anomalyRefundPath(ANOMALY.open), changedBody);
    await mount(server);
    const modal = await openAnomalyRefund(await openAnomalies(ANOMALY_TRADE_NO.open));
    await fillRefund(modal, { amount: '2.00', reason: 'ANOMALY_RECEIPT' });
    const before = snapshotText();
    await submitRefund(modal);
    await waitFor(() => expect(server.anomalyRefunds(ANOMALY.open)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(before)).toMatch(CHANGED));
    await settle();
    await settled(server);
    expect(server.anomalyRefunds()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-ANOMALY#9] 异常收款退款收 40901（同一请求处理中）：提示稍后查看，不自动重发',
  async () => {
    const server = refundServer(ANOMALY.open);
    server.once('POST', anomalyRefundPath(ANOMALY.open), inProgress);
    await mount(server);
    const modal = await openAnomalyRefund(await openAnomalies(ANOMALY_TRADE_NO.open));
    await fillRefund(modal, { amount: '2.00', reason: 'ANOMALY_RECEIPT' });
    const before = snapshotText();
    await submitRefund(modal);
    await waitFor(() => expect(server.anomalyRefunds(ANOMALY.open)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(freshText(before)).toMatch(RUNNING));
    await settle();
    await settled(server);
    expect(server.anomalyRefunds()).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13b-ANOMALY#10] 异常收款退款请求在途时再点提交（连点两下）：只发一次 POST，放行后提示受理',
  async () => {
    const server = refundServer(ANOMALY.open);
    await mount(server);
    const modal = await openAnomalyRefund(await openAnomalies(ANOMALY_TRADE_NO.open));
    await fillRefund(modal, { amount: '2.00', reason: 'ANOMALY_RECEIPT' });
    const before = snapshotText();
    const release = server.hold('POST', anomalyRefundPath(ANOMALY.open));
    try {
      const submit = action(modal, SUBMIT);
      await act(async () => {
        fireEvent.click(submit);
        fireEvent.click(submit);
      });
      await settle();
      await waitFor(() => expect(server.anomalyRefunds(ANOMALY.open)).toHaveLength(1));
      await click(submit);
      await settle();
      expect(server.anomalyRefunds(ANOMALY.open)).toHaveLength(1);
    } finally {
      release();
    }
    await settled(server);
    expect(server.anomalyRefunds()).toHaveLength(1);
    assertRefund(server.anomalyRefunds(ANOMALY.open)[0]!, 200, 'ANOMALY_RECEIPT');
    await waitFor(() => expect(freshText(before)).toMatch(ACCEPTED));
  },
  FLOW_TIMEOUT,
);
