// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ANOMALY_TRADE_NO,
  ORDER,
  OUT_REFUND_NO,
  OUT_TRADE_NO,
  PERIOD,
  VIEW_GRANTS,
  createServer,
  detailRoute,
  snapshot,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  TAB,
  WRITE_ACTIONS,
  actions,
  assertNoStepUp,
  click,
  dayRows,
  listed,
  main,
  mount,
  openTab,
  rowsWith,
  settle,
  settled,
  token,
  usable,
} from './helpers.ts';

/** Presses every write-named control of the page (a disabled one does nothing). */
async function pressWrites(): Promise<void> {
  for (const node of actions(document.body, WRITE_ACTIONS)) {
    await click(node);
    await settle();
  }
}

it(
  '[AC-F1-13a-READONLY#1] 持 pay.view：支付单、异常收款、收款对账三个页签都没有可用的【发起退款】【立即查询】【处置】【导出】【手动下载并核对】等写入口；点了也只发四个 GET，不弹动态码',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(OUT_TRADE_NO.manual);
    expect(usable(main(), WRITE_ACTIONS), 'no usable write on the pay order list').toEqual([]);
    await pressWrites();

    await openTab(TAB.anomalies);
    await listed(ANOMALY_TRADE_NO.closedOrder);
    expect(usable(main(), WRITE_ACTIONS), 'no usable write on the anomaly list').toEqual([]);
    await pressWrites();

    await openTab(TAB.recon);
    await waitFor(() => expect(dayRows(PERIOD.mismatch)).toHaveLength(1));
    expect(usable(main(), WRITE_ACTIONS), 'no usable write on the reconciliation tab').toEqual([]);
    await pressWrites();

    await settled(server);
    expect(server.others(), 'only the four GETs of CT-21e').toEqual([]);
    expect(server.log.filter((request) => request.method !== 'GET')).toEqual([]);
    assertNoStepUp(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-READONLY#2] 只持 pay.view 的账号看部分退款的已支付单详情：没有可用的【发起退款】【立即查询】【处置】等写入口；点了也只发四个 GET 之一，不弹动态码',
  async () => {
    const server = createServer();
    await mount(server, { snapshot: snapshot(VIEW_GRANTS), route: detailRoute(ORDER.refunded) });
    await waitFor(() => expect(server.detailReads(ORDER.refunded).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() =>
      expect(rowsWith(document.body, [token(OUT_REFUND_NO.success)])).toHaveLength(1),
    );
    expect(usable(document.body, WRITE_ACTIONS), 'no usable write on the detail').toEqual([]);
    await pressWrites();
    await settled(server);
    expect(server.others(), 'only the four GETs of CT-21e').toEqual([]);
    expect(server.log.filter((request) => request.method !== 'GET')).toEqual([]);
    assertNoStepUp(server);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-READONLY#3] 只持 pay.view 的账号看待人工处置的支付单详情（PENDING、needs_manual）：没有可用的【立即查询】【处置】；不读退款单列表等其他接口',
  async () => {
    const server = createServer();
    await mount(server, { snapshot: snapshot(VIEW_GRANTS), route: detailRoute(ORDER.manual) });
    await waitFor(() => expect(server.detailReads(ORDER.manual).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(document.body.textContent).toContain(OUT_TRADE_NO.manual));
    expect(usable(document.body, WRITE_ACTIONS), 'no usable write on the detail').toEqual([]);
    await pressWrites();
    await settled(server);
    expect(server.others()).toEqual([]);
    expect(server.requests('GET', '/admin/v1/pay-refunds')).toEqual([]);
    assertNoStepUp(server);
  },
  FLOW_TIMEOUT,
);
