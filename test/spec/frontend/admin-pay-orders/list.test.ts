// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  BIZ,
  CHANNEL_USER,
  ORDER,
  ORDERS,
  ORDER_FILTERS,
  ORDER_PARAMS,
  OUT_TRADE_NO,
  USER,
  createServer,
  fillerOutTradeNo,
  withFillerOrders,
} from './fixtures.ts';
import {
  BALANCE_NOTE,
  DETAIL_ENTRY,
  FLOW_TIMEOUT,
  NOT_A_VALUE,
  ORDER_COLUMN,
  assertPaging,
  cellText,
  click,
  extraParams,
  idToken,
  listed,
  main,
  mount,
  nextPageNear,
  rowOf,
  rowsOf,
  settled,
  showsName,
  showsYuan,
  squash,
  textOf,
  usable,
} from './helpers.ts';

interface Expected {
  readonly outTradeNo: string;
  readonly user: string;
  readonly biz: string;
  readonly channel: string;
  readonly status: string;
  /** amount_fen in yuan. */
  readonly amount: string;
  /** refunded_fen in yuan. */
  readonly refunded: string;
  /** created_at in Beijing time, spaces removed. */
  readonly created: string;
}

/**
 * Expected cells of the four samples, computed by hand from the fen in fixtures.ts; within a row
 * the amount and the refunded total differ, so a value shown under the other column fails.
 */
const EXPECTED: readonly Expected[] = [
  {
    outTradeNo: OUT_TRADE_NO.manual,
    user: USER.manual,
    biz: BIZ.membership,
    channel: 'wechat_pay',
    status: 'PENDING',
    // 1900 fen; nothing refunded.
    amount: '19.00',
    refunded: '0.00',
    created: '2026-10-2010:30',
  },
  {
    outTradeNo: OUT_TRADE_NO.refunded,
    user: USER.refunded,
    biz: BIZ.membership,
    channel: 'alipay',
    status: 'PAID',
    // 12800 fen; 3050 fen refunded.
    amount: '128.00',
    refunded: '30.50',
    created: '2026-10-1909:00',
  },
  {
    outTradeNo: OUT_TRADE_NO.closed,
    user: USER.closed,
    biz: BIZ.trial,
    channel: 'wechat_pay',
    status: 'CLOSED',
    // 990 fen; nothing refunded.
    amount: '9.90',
    refunded: '0.00',
    created: '2026-10-1808:00',
  },
  {
    outTradeNo: OUT_TRADE_NO.paid,
    user: USER.paid,
    biz: BIZ.membership,
    channel: 'wechat_pay',
    status: 'PAID',
    // 2500 fen; nothing refunded.
    amount: '25.00',
    refunded: '0.00',
    created: '2026-10-1714:20',
  },
];

it(
  '[AC-F1-13a-LIST#1] 进入后读支付单第 1 页（page_size ≤ 200、不带筛选、只用契约参数），按返回顺序（创建时间倒序）列出四张支付单',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(OUT_TRADE_NO.paid);
    await settled(server);
    assertPaging(server.orderReads(), ORDER_PARAMS);
    const first = server.tableReads(ORDERS)[0];
    expect(first, 'an unfiltered table read').toBeDefined();
    expect(first!.query['page'] ?? '1').toBe('1');
    for (const name of ORDER_FILTERS) expect(first!.query[name], `no ${name}`).toBeUndefined();
    const order = [
      OUT_TRADE_NO.manual,
      OUT_TRADE_NO.refunded,
      OUT_TRADE_NO.closed,
      OUT_TRADE_NO.paid,
    ];
    const nodes = order.map((number) => rowOf(number));
    // Node.DOCUMENT_POSITION_FOLLOWING, spelled out so no environment global is needed.
    const following = 0x4;
    for (let index = 1; index < nodes.length; index += 1) {
      const relation = nodes[index - 1]!.compareDocumentPosition(nodes[index]!);
      expect(relation & following, `${order[index]} after ${order[index - 1]}`).not.toBe(0);
    }
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-LIST#2] 每行在各自的列下显示用户、业务、渠道（字典名）、金额与已退（元，两位小数，按分手算，互不对调）、状态（字典名，缺键显示编码），并显示商户单号、创建时间与【详情】',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(OUT_TRADE_NO.paid);
    for (const expected of EXPECTED) {
      const label = expected.outTradeNo;
      const row = rowOf(expected.outTradeNo);
      expect(cellText(row, ORDER_COLUMN.user), `${label} user`).toMatch(idToken(expected.user));
      expect(
        showsName(cellText(row, ORDER_COLUMN.biz), 'bizType', expected.biz),
        `${label} biz`,
      ).toBe(true);
      expect(
        showsName(cellText(row, ORDER_COLUMN.channel), 'channel', expected.channel),
        `${label} channel`,
      ).toBe(true);
      expect(
        showsName(cellText(row, ORDER_COLUMN.status), 'payStatus', expected.status),
        `${label} status`,
      ).toBe(true);

      const amount = cellText(row, ORDER_COLUMN.amount);
      expect(showsYuan(amount, expected.amount), `${label} amount ${expected.amount}`).toBe(true);
      expect(showsYuan(amount, expected.refunded), `${label} amount ≠ refunded`).toBe(false);
      const refunded = cellText(row, ORDER_COLUMN.refunded);
      expect(showsYuan(refunded, expected.refunded), `${label} refunded ${expected.refunded}`).toBe(
        true,
      );
      expect(showsYuan(refunded, expected.amount), `${label} refunded ≠ amount`).toBe(false);

      expect(squash(textOf(row)), `${label} created_at (Beijing)`).toContain(expected.created);
      expect(textOf(row), `${label} no raw value`).not.toMatch(NOT_A_VALUE);
      expect(usable(row, DETAIL_ENTRY).length, `${label} 【详情】`).toBeGreaterThan(0);
    }
    // The status of the CLOSED sample is not shown as PAID, nor PAID as PENDING.
    expect(
      showsName(cellText(rowOf(OUT_TRADE_NO.closed), ORDER_COLUMN.status), 'payStatus', 'PAID'),
    ).toBe(false);
    expect(
      showsName(cellText(rowOf(OUT_TRADE_NO.paid), ORDER_COLUMN.status), 'payStatus', 'PENDING'),
    ).toBe(false);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-LIST#3] 列表不显示渠道侧用户标识（契约不返回；假服务端夹带的对照值也不出现），页面常驻说明收款不进用户余额（BR-PAY-07）',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(OUT_TRADE_NO.refunded);
    const page = document.body.textContent ?? '';
    for (const value of Object.values(CHANNEL_USER))
      expect(page, `channel-side user ${value}`).not.toContain(value);
    expect(squash(main().textContent)).toMatch(BALANCE_NOTE);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-LIST#4] 页码分页：切到第 2 页请求 page=2（同一 page_size），显示该页的支付单、不再显示第 1 页的支付单',
  async () => {
    const server = createServer(withFillerOrders(205));
    await mount(server);
    await listed(OUT_TRADE_NO.manual);
    await settled(server);
    const reads = server.tableReads(ORDERS).length;
    const firstSize = Number(server.tableReads(ORDERS).at(-1)!.query['page_size'] ?? '20');
    await nextPageNear(rowOf(OUT_TRADE_NO.manual));
    const paged = () =>
      server
        .tableReads(ORDERS)
        .slice(reads)
        .filter((read) => read.query['page'] === '2');
    await waitFor(() => expect(paged().length).toBeGreaterThan(0));
    await settled(server);
    const second = paged().at(-1)!;
    expect(extraParams(second.query, ORDER_PARAMS)).toEqual([]);
    expect(Number(second.query['page_size'] ?? '20'), 'page 2 keeps the page_size').toBe(firstSize);
    // Four samples, then filler 1, 2, … (created_at descending): row index `size` opens page 2.
    const firstOfPage = fillerOutTradeNo(firstSize - 3);
    await waitFor(() => expect(rowsOf(firstOfPage), firstOfPage).toHaveLength(1));
    for (const number of Object.values(OUT_TRADE_NO))
      expect(rowsOf(number), `no page-1 row ${number}`).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-LIST#5] 行的【详情】打开该支付单：只读 pay-orders/{pay_order_id}，不读别的支付单',
  async () => {
    const server = createServer();
    await mount(server);
    const row = await listed(OUT_TRADE_NO.refunded);
    await settled(server);
    const entries = usable(row, DETAIL_ENTRY);
    expect(entries.length, '【详情】').toBeGreaterThan(0);
    await click(entries[0]!);
    await waitFor(() => expect(server.detailReads(ORDER.refunded).length).toBeGreaterThan(0));
    await settled(server);
    for (const id of [ORDER.manual, ORDER.closed, ORDER.paid])
      expect(server.detailReads(id), id.slice(0, 8)).toEqual([]);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);
