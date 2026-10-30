// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  DIFFS,
  DIFF_FILTERS,
  DIFF_PARAMS,
  PERIOD,
  createServer,
  fillerPeriod,
  namePattern,
  withFillerDiffs,
} from './fixtures.ts';
import {
  BALANCE_NOTE,
  DIFF_COLUMN,
  FLOW_TIMEOUT,
  LABEL,
  NOT_A_VALUE,
  TAB,
  actions,
  assertPaging,
  cellText,
  choose,
  click,
  dayRow,
  dayRows,
  extraParams,
  main,
  mount,
  nextPageNear,
  openTab,
  query,
  scope,
  settled,
  showsName,
  showsYuan,
  squash,
  textOf,
  usable,
} from './helpers.ts';

interface Expected {
  readonly period: string;
  readonly type: string;
  readonly status: string;
  readonly expected: string;
  readonly actual: string;
  /** diff_fen in yuan, with its sign. */
  readonly diff: string;
}

/**
 * The three R4 samples, hand-computed from the fen in fixtures.ts; within a row the three amounts
 * differ (a negative difference keeps its minus sign, so -45.60 is not 45.60).
 */
const EXPECTED: readonly Expected[] = [
  {
    period: PERIOD.mismatch,
    type: 'pay_mismatch',
    status: 'open',
    // 12800 / 9900 / 2900 fen.
    expected: '128.00',
    actual: '99.00',
    diff: '29.00',
  },
  {
    period: PERIOD.anomaly,
    type: 'pay_anomaly',
    status: 'processing',
    // 0 / 4560 / −4560 fen.
    expected: '0.00',
    actual: '45.60',
    diff: '-45.60',
  },
  {
    period: PERIOD.closed,
    type: 'pay_mismatch',
    status: 'closed',
    // 3050 / 2050 / 1000 fen.
    expected: '30.50',
    actual: '20.50',
    diff: '10.00',
  },
];

/** The manual download and check of a channel bill is not in this part. */
const MANUAL_CHECK = /^(?:手动下载并核对|下载并核对|手动核对|重新核对|立即核对)/;

async function openRecon(server: ReturnType<typeof createServer>, period: string) {
  await openTab(TAB.recon);
  await waitFor(() => expect(server.diffReads().length).toBeGreaterThan(0));
  await settled(server);
  await waitFor(() => expect(dayRows(period), `row ${period}`).toHaveLength(1));
  return dayRow(period);
}

it(
  '[AC-F1-13a-RECON#1] 「收款对账」页签读 pay-recon-diffs 第 1 页（不带筛选、只用契约参数），按返回顺序列出三条 R4 差错单；页签内仍有收款不进用户余额的说明',
  async () => {
    const server = createServer();
    await mount(server);
    await openRecon(server, PERIOD.closed);
    assertPaging(server.diffReads(), DIFF_PARAMS);
    const first = server.tableReads(DIFFS)[0];
    expect(first, 'an unfiltered table read').toBeDefined();
    expect(first!.query['page'] ?? '1').toBe('1');
    for (const name of DIFF_FILTERS) expect(first!.query[name], `no ${name}`).toBeUndefined();
    const nodes = EXPECTED.map((expected) => dayRow(expected.period));
    const following = 0x4;
    for (let index = 1; index < nodes.length; index += 1)
      expect(nodes[index - 1]!.compareDocumentPosition(nodes[index]!) & following).not.toBe(0);
    expect(squash(main().textContent)).toMatch(BALANCE_NOTE);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-RECON#2] 每行在各自的列下显示类型与状态的字典名、我方金额 / 渠道金额 / 差额（按分手算，差额保留负号，三者不对调）与账单日',
  async () => {
    const server = createServer();
    await mount(server);
    await openRecon(server, PERIOD.closed);
    for (const expected of EXPECTED) {
      const label = expected.period;
      const row = dayRow(expected.period);
      expect(
        showsName(cellText(row, DIFF_COLUMN.type), 'diffType', expected.type),
        `${label} type`,
      ).toBe(true);
      expect(
        showsName(cellText(row, DIFF_COLUMN.status), 'diffStatus', expected.status),
        `${label} status`,
      ).toBe(true);
      const values = [expected.expected, expected.actual, expected.diff];
      for (const [column, own] of [
        [DIFF_COLUMN.expected, expected.expected],
        [DIFF_COLUMN.actual, expected.actual],
        [DIFF_COLUMN.diff, expected.diff],
      ] as const) {
        const text = cellText(row, column);
        expect(showsYuan(text, own), `${label} ${String(column)} shows ${own} (${text})`).toBe(
          true,
        );
        for (const other of values.filter((value) => value !== own))
          expect(showsYuan(text, other), `${label} ${String(column)} not ${other}`).toBe(false);
      }
      expect(textOf(row), `${label} no raw value`).not.toMatch(NOT_A_VALUE);
    }
    // pay_anomaly is not shown as pay_mismatch.
    expect(
      showsName(cellText(dayRow(PERIOD.anomaly), DIFF_COLUMN.type), 'diffType', 'pay_mismatch'),
    ).toBe(false);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-RECON#3] 类型 + 状态筛选：【查询】带 type / status（契约参数名、编码值），从第 1 页起，只列命中的差错单',
  async () => {
    const server = createServer();
    await mount(server);
    await openRecon(server, PERIOD.mismatch);
    const filters = { type: 'pay_mismatch', status: 'closed' };
    await choose(scope(), LABEL.diffType, namePattern('diffType', 'pay_mismatch', true));
    await choose(scope(), LABEL.status, namePattern('diffStatus', 'closed', true));
    await query();
    await waitFor(() => expect(server.tableReads(DIFFS, filters).length).toBeGreaterThan(0));
    await settled(server);
    const sent = server.tableReads(DIFFS, filters).at(-1)!;
    expect(sent.query).toMatchObject(filters);
    expect(sent.query['page'] ?? '1').toBe('1');
    expect(extraParams(sent.query, DIFF_PARAMS)).toEqual([]);
    await waitFor(() => expect(dayRows(PERIOD.mismatch)).toEqual([]));
    expect(dayRows(PERIOD.closed)).toHaveLength(1);
    expect(dayRows(PERIOD.anomaly)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-RECON#4] 页码分页：切到第 2 页请求 page=2（同一 page_size），显示该页的差错单、不再显示第 1 页的',
  async () => {
    const server = createServer(undefined, { diffs: withFillerDiffs(205) });
    await mount(server);
    await openRecon(server, PERIOD.mismatch);
    const reads = server.tableReads(DIFFS).length;
    const firstSize = Number(server.tableReads(DIFFS).at(-1)!.query['page_size'] ?? '20');
    await nextPageNear(dayRow(PERIOD.mismatch));
    const paged = () =>
      server
        .tableReads(DIFFS)
        .slice(reads)
        .filter((read) => read.query['page'] === '2');
    await waitFor(() => expect(paged().length).toBeGreaterThan(0));
    await settled(server);
    const second = paged().at(-1)!;
    expect(extraParams(second.query, DIFF_PARAMS)).toEqual([]);
    expect(Number(second.query['page_size'] ?? '20')).toBe(firstSize);
    // Three samples, then filler 1, 2, …: row index `size` opens page 2.
    const firstOfPage = fillerPeriod(firstSize - 2);
    await waitFor(() => expect(dayRows(firstOfPage), firstOfPage).toHaveLength(1));
    for (const period of Object.values(PERIOD))
      expect(dayRows(period), `no page-1 row ${period}`).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-RECON#5] 收款对账页签只读差错单：没有可用的【手动下载并核对】，点了也只发四个 GET 之一，不读对账任务',
  async () => {
    const server = createServer();
    await mount(server);
    await openRecon(server, PERIOD.mismatch);
    expect(usable(main(), MANUAL_CHECK), 'no usable manual check').toEqual([]);
    for (const node of actions(document.body, MANUAL_CHECK)) await click(node);
    await settled(server);
    expect(server.others()).toEqual([]);
    expect(server.log.filter((request) => request.method !== 'GET')).toEqual([]);
  },
  FLOW_TIMEOUT,
);
