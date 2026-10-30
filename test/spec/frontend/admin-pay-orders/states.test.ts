// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ANOMALIES,
  ANOMALY_TRADE_NO,
  DIFFS,
  ORDERS,
  OUT_TRADE_NO,
  PERIOD,
  createServer,
  namePattern,
  tableRead,
  unavailable,
} from './fixtures.ts';
import {
  EMPTY,
  FLOW_TIMEOUT,
  LABEL,
  LOAD_FAILED,
  RETRY,
  TAB,
  action,
  choose,
  click,
  dayRows,
  listed,
  mount,
  openTab,
  query,
  rowsOf,
  scope,
  settle,
  settled,
} from './helpers.ts';

// Only the table read of a list (a read of its path under the current filters, see
// isTableQuery) is held or fails; count reads the page may send with page_size=1 are answered as
// usual.

function busy(): boolean {
  const area = scope();
  return (
    area.querySelector('[aria-busy="true"], [role="progressbar"], .ant-spin-spinning') !== null ||
    /加载/.test(area.textContent ?? '')
  );
}
function text(): string {
  return scope().textContent ?? '';
}

it(
  '[AC-F1-13a-STATE#1] 支付单列表加载中：表格请求未返回时显示加载状态、没有支付单行，返回后列出',
  async () => {
    const server = createServer();
    const release = server.hold('GET', ORDERS, undefined, tableRead(ORDERS));
    try {
      await mount(server);
      await waitFor(() => expect(server.tableReads(ORDERS).length).toBeGreaterThan(0));
      await settle();
      expect(busy(), 'a loading state').toBe(true);
      expect(rowsOf(OUT_TRADE_NO.refunded)).toEqual([]);
    } finally {
      release();
    }
    await settled(server);
    await listed(OUT_TRADE_NO.refunded);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-STATE#2] 支付单列表出错可重试：表格请求失败显示出错与【重试】，重试成功后列出',
  async () => {
    const server = createServer();
    const recover = server.always('GET', ORDERS, unavailable, tableRead(ORDERS));
    await mount(server);
    await waitFor(() => expect(server.tableReads(ORDERS).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(text()).toMatch(LOAD_FAILED));
    expect(rowsOf(OUT_TRADE_NO.refunded)).toEqual([]);
    recover();
    const reads = server.tableReads(ORDERS).length;
    await click(action(scope(), RETRY));
    await waitFor(() => expect(server.tableReads(ORDERS).length).toBeGreaterThan(reads));
    await settled(server);
    await listed(OUT_TRADE_NO.refunded);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-STATE#3] 支付单再查失败不显示旧数据：换条件【查询】的表格请求失败时显示出错、不再显示之前的支付单，重试后按该条件列出',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(OUT_TRADE_NO.refunded);
    await settled(server);
    const filters = { status: 'CLOSED' };
    const recover = server.always('GET', ORDERS, unavailable, tableRead(ORDERS, filters));
    const reads = server.tableReads(ORDERS, filters).length;
    await choose(scope(), LABEL.status, namePattern('payStatus', 'CLOSED', true));
    await query();
    await waitFor(() => expect(server.tableReads(ORDERS, filters).length).toBeGreaterThan(reads));
    await settled(server);
    await waitFor(() => expect(text()).toMatch(LOAD_FAILED));
    for (const number of Object.values(OUT_TRADE_NO))
      expect(rowsOf(number), `no stale row ${number}`).toEqual([]);
    recover();
    const failed = server.tableReads(ORDERS, filters).length;
    await click(action(scope(), RETRY));
    await waitFor(() => expect(server.tableReads(ORDERS, filters).length).toBeGreaterThan(failed));
    await settled(server);
    await listed(OUT_TRADE_NO.closed);
    expect(rowsOf(OUT_TRADE_NO.refunded)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-STATE#4] 支付单空列表：显示空状态，没有支付单行，不发四个 GET 以外的请求',
  async () => {
    const server = createServer([]);
    await mount(server);
    await waitFor(() => expect(server.tableReads(ORDERS).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(text()).toMatch(EMPTY));
    expect(rowsOf(OUT_TRADE_NO.refunded)).toEqual([]);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-STATE#5] 异常收款出错可重试：表格请求失败显示出错与【重试】、没有异常收款行，重试成功后列出',
  async () => {
    const server = createServer();
    const recover = server.always('GET', ANOMALIES, unavailable, tableRead(ANOMALIES));
    await mount(server);
    await openTab(TAB.anomalies);
    await waitFor(() => expect(server.tableReads(ANOMALIES).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(text()).toMatch(LOAD_FAILED));
    expect(rowsOf(ANOMALY_TRADE_NO.closedOrder)).toEqual([]);
    recover();
    const reads = server.tableReads(ANOMALIES).length;
    await click(action(scope(), RETRY));
    await waitFor(() => expect(server.tableReads(ANOMALIES).length).toBeGreaterThan(reads));
    await settled(server);
    await listed(ANOMALY_TRADE_NO.closedOrder);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-STATE#6] 异常收款空列表：显示空状态，没有异常收款行',
  async () => {
    const server = createServer(undefined, { anomalies: [] });
    await mount(server);
    await openTab(TAB.anomalies);
    await waitFor(() => expect(server.tableReads(ANOMALIES).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(text()).toMatch(EMPTY));
    expect(rowsOf(ANOMALY_TRADE_NO.closedOrder)).toEqual([]);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-STATE#7] 收款对账加载中：差错单表格请求未返回时显示加载状态、没有差错单行，返回后列出',
  async () => {
    const server = createServer();
    const release = server.hold('GET', DIFFS, undefined, tableRead(DIFFS));
    try {
      await mount(server);
      await openTab(TAB.recon);
      await waitFor(() => expect(server.tableReads(DIFFS).length).toBeGreaterThan(0));
      await settle();
      expect(busy(), 'a loading state').toBe(true);
      expect(dayRows(PERIOD.mismatch)).toEqual([]);
    } finally {
      release();
    }
    await settled(server);
    await waitFor(() => expect(dayRows(PERIOD.mismatch)).toHaveLength(1));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-STATE#8] 收款对账再查失败不显示旧数据：换类型【查询】失败时显示出错、不再显示之前的差错单，重试后按该条件列出',
  async () => {
    const server = createServer();
    await mount(server);
    await openTab(TAB.recon);
    await waitFor(() => expect(dayRows(PERIOD.mismatch)).toHaveLength(1));
    await settled(server);
    const filters = { type: 'pay_anomaly' };
    const recover = server.always('GET', DIFFS, unavailable, tableRead(DIFFS, filters));
    const reads = server.tableReads(DIFFS, filters).length;
    await choose(scope(), LABEL.diffType, namePattern('diffType', 'pay_anomaly', true));
    await query();
    await waitFor(() => expect(server.tableReads(DIFFS, filters).length).toBeGreaterThan(reads));
    await settled(server);
    await waitFor(() => expect(text()).toMatch(LOAD_FAILED));
    for (const period of Object.values(PERIOD))
      expect(dayRows(period), `no stale row ${period}`).toEqual([]);
    recover();
    const failed = server.tableReads(DIFFS, filters).length;
    await click(action(scope(), RETRY));
    await waitFor(() => expect(server.tableReads(DIFFS, filters).length).toBeGreaterThan(failed));
    await settled(server);
    await waitFor(() => expect(dayRows(PERIOD.anomaly)).toHaveLength(1));
    expect(dayRows(PERIOD.mismatch)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-STATE#9] 收款对账空列表：显示空状态，没有差错单行',
  async () => {
    const server = createServer(undefined, { diffs: [] });
    await mount(server);
    await openTab(TAB.recon);
    await waitFor(() => expect(server.tableReads(DIFFS).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(text()).toMatch(EMPTY));
    expect(dayRows(PERIOD.mismatch)).toEqual([]);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);
