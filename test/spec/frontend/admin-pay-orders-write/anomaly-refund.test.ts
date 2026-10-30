// @vitest-environment jsdom
import { cleanup, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ANOMALY,
  ANOMALY_TRADE_NO,
  REFUNDABLE,
  VIEW_GRANTS,
  VIEW_REFUND_GRANTS,
  anomalyRefundPath,
  createServer,
  networkDown,
  rejected,
} from './fixtures.ts';
import {
  ACCEPTED,
  FLOW_TIMEOUT,
  LABEL,
  NOT_FOUND,
  SUBMIT,
  action,
  anomalyRefundEntries,
  assertNoStepUp,
  assertRefund,
  click,
  fieldError,
  fill,
  fillRefund,
  freshText,
  main,
  mount,
  openAnomalies,
  openAnomalyRefund,
  openDialogs,
  pressWrites,
  refundDialog,
  refundDialogs,
  refundableShown,
  requestKey,
  settle,
  settled,
  snapshotText,
  submitRefund,
  textbox,
} from './helpers.ts';

it(
  '[AC-F1-13b-ANOMALY#1] 持 pay.refund：异常收款行的【退款】打开原路退款对话框（不弹动态码），可退金额若显示为 9.90；填 9.90、原因「异常收款退回」提交 POST /admin/v1/pay-anomalies/{id}/refunds（amount_fen=990、Idempotency-Key），提示已受理；不发其他写请求、不读退款单列表',
  async () => {
    const server = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
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
    const server = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
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
    const server = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
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
    const server = createServer(undefined, { permissions: VIEW_REFUND_GRANTS });
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
