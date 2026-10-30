// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ANOMALIES,
  ANOMALY_FILTERS,
  ANOMALY_PARAMS,
  ANOMALY_TRADE_NO,
  OUT_TRADE_NO,
  createServer,
  fillerAnomalyTradeNo,
  namePattern,
  withFillerAnomalies,
} from './fixtures.ts';
import {
  ANOMALY_COLUMN,
  FLOW_TIMEOUT,
  LABEL,
  NOT_A_VALUE,
  TAB,
  assertPaging,
  cellText,
  choose,
  extraParams,
  listed,
  mount,
  nextPageNear,
  openTab,
  query,
  rowOf,
  rowsOf,
  scope,
  settled,
  showsName,
  showsYuan,
  squash,
  textOf,
} from './helpers.ts';

interface Expected {
  readonly tradeNo: string;
  readonly channel: string;
  readonly status: string;
  readonly amount: string;
  readonly refunded: string;
  /** created_at (when it was registered) in Beijing time, spaces removed. */
  readonly received: string;
}

/** The three samples, hand-computed from the fen in fixtures.ts. */
const EXPECTED: readonly Expected[] = [
  {
    tradeNo: ANOMALY_TRADE_NO.closedOrder,
    channel: 'wechat_pay',
    status: 'open',
    // 990 fen; nothing refunded.
    amount: '9.90',
    refunded: '0.00',
    received: '2026-10-2102:10',
  },
  {
    tradeNo: ANOMALY_TRADE_NO.unknownOrder,
    channel: 'alipay',
    status: 'open',
    // 6600 fen; 1600 fen refunded.
    amount: '66.00',
    refunded: '16.00',
    received: '2026-10-2003:25',
  },
  {
    tradeNo: ANOMALY_TRADE_NO.refunded,
    channel: 'alipay',
    status: 'refunded',
    // 3300 fen, all refunded.
    amount: '33.00',
    refunded: '33.00',
    received: '2026-10-1904:40',
  },
];

/** Opens 异常收款 and waits for the row of `tradeNo`. */
async function openAnomalies(server: ReturnType<typeof createServer>, tradeNo: string) {
  await openTab(TAB.anomalies);
  await waitFor(() => expect(server.anomalyReads().length).toBeGreaterThan(0));
  await settled(server);
  return listed(tradeNo);
}

it(
  '[AC-F1-13a-ANOMALY#1] 「异常收款」页签读 pay-anomalies 第 1 页（不带筛选、page_size ≤ 200、只用契约参数），按返回顺序列出三条异常收款',
  async () => {
    const server = createServer();
    await mount(server);
    await openAnomalies(server, ANOMALY_TRADE_NO.refunded);
    assertPaging(server.anomalyReads(), ANOMALY_PARAMS);
    const first = server.tableReads(ANOMALIES)[0];
    expect(first, 'an unfiltered table read').toBeDefined();
    expect(first!.query['page'] ?? '1').toBe('1');
    for (const name of ANOMALY_FILTERS) expect(first!.query[name], `no ${name}`).toBeUndefined();
    const nodes = EXPECTED.map((expected) => rowOf(expected.tradeNo));
    const following = 0x4;
    for (let index = 1; index < nodes.length; index += 1)
      expect(nodes[index - 1]!.compareDocumentPosition(nodes[index]!) & following).not.toBe(0);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-ANOMALY#2] 每行显示渠道交易号、渠道（字典名）、金额与已退（按分手算、各在其列）、收到时间与状态（缺字典键显示编码）；没有我方单号的行不显示 null',
  async () => {
    const server = createServer();
    await mount(server);
    await openAnomalies(server, ANOMALY_TRADE_NO.refunded);
    for (const expected of EXPECTED) {
      const label = expected.tradeNo;
      const row = rowOf(expected.tradeNo);
      expect(
        showsName(cellText(row, ANOMALY_COLUMN.channel), 'channel', expected.channel),
        `${label} channel`,
      ).toBe(true);
      expect(
        showsName(cellText(row, ANOMALY_COLUMN.status), 'anomalyStatus', expected.status),
        `${label} status`,
      ).toBe(true);
      const amount = cellText(row, ANOMALY_COLUMN.amount);
      expect(showsYuan(amount, expected.amount), `${label} amount ${expected.amount}`).toBe(true);
      const refunded = cellText(row, ANOMALY_COLUMN.refunded);
      expect(showsYuan(refunded, expected.refunded), `${label} refunded`).toBe(true);
      if (expected.amount !== expected.refunded) {
        expect(showsYuan(amount, expected.refunded), `${label} amount ≠ refunded`).toBe(false);
        expect(showsYuan(refunded, expected.amount), `${label} refunded ≠ amount`).toBe(false);
      }
      expect(squash(textOf(row)), `${label} received (Beijing)`).toContain(expected.received);
      expect(textOf(row), `${label} no raw value`).not.toMatch(NOT_A_VALUE);
    }
    // The anomaly of the CLOSED pay order shows our merchant order number.
    expect(textOf(rowOf(ANOMALY_TRADE_NO.closedOrder))).toContain(OUT_TRADE_NO.closed);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-ANOMALY#3] 渠道筛选：【查询】带 pay_channel（契约参数名、编码值），从第 1 页起，只列该渠道的异常收款',
  async () => {
    const server = createServer();
    await mount(server);
    await openAnomalies(server, ANOMALY_TRADE_NO.closedOrder);
    const filters = { pay_channel: 'alipay' };
    await choose(scope(), LABEL.channel, namePattern('channel', 'alipay', true));
    await query();
    await waitFor(() => expect(server.tableReads(ANOMALIES, filters).length).toBeGreaterThan(0));
    await settled(server);
    const sent = server.tableReads(ANOMALIES, filters).at(-1)!;
    expect(sent.query).toMatchObject(filters);
    expect(sent.query['page'] ?? '1').toBe('1');
    expect(extraParams(sent.query, ANOMALY_PARAMS)).toEqual([]);
    await waitFor(() => expect(rowsOf(ANOMALY_TRADE_NO.closedOrder)).toEqual([]));
    expect(rowsOf(ANOMALY_TRADE_NO.unknownOrder)).toHaveLength(1);
    expect(rowsOf(ANOMALY_TRADE_NO.refunded)).toHaveLength(1);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-ANOMALY#4] 页码分页：切到第 2 页请求 page=2（同一 page_size），显示该页的异常收款、不再显示第 1 页的',
  async () => {
    const server = createServer(undefined, { anomalies: withFillerAnomalies(205) });
    await mount(server);
    await openAnomalies(server, ANOMALY_TRADE_NO.closedOrder);
    const reads = server.tableReads(ANOMALIES).length;
    const firstSize = Number(server.tableReads(ANOMALIES).at(-1)!.query['page_size'] ?? '20');
    await nextPageNear(rowOf(ANOMALY_TRADE_NO.closedOrder));
    const paged = () =>
      server
        .tableReads(ANOMALIES)
        .slice(reads)
        .filter((read) => read.query['page'] === '2');
    await waitFor(() => expect(paged().length).toBeGreaterThan(0));
    await settled(server);
    const second = paged().at(-1)!;
    expect(extraParams(second.query, ANOMALY_PARAMS)).toEqual([]);
    expect(Number(second.query['page_size'] ?? '20')).toBe(firstSize);
    // Three samples, then filler 1, 2, …: row index `size` opens page 2.
    const firstOfPage = fillerAnomalyTradeNo(firstSize - 2);
    await waitFor(() => expect(rowsOf(firstOfPage), firstOfPage).toHaveLength(1));
    for (const tradeNo of Object.values(ANOMALY_TRADE_NO))
      expect(rowsOf(tradeNo), `no page-1 row ${tradeNo}`).toEqual([]);
  },
  FLOW_TIMEOUT,
);
