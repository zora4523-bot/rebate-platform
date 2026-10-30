// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import {
  ORDERS,
  ORDER_FILTERS,
  ORDER_PARAMS,
  OUT_TRADE_NO,
  USER,
  createServer,
  namePattern,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  LABEL,
  RESET,
  action,
  choose,
  click,
  extraParams,
  fill,
  listed,
  mount,
  query,
  rowsOf,
  scope,
  settle,
  settled,
  textbox,
} from './helpers.ts';

it(
  '[AC-F1-13a-FILTER#1] 状态 + 渠道筛选：【查询】带 status / pay_channel（契约参数名、编码值），从第 1 页起，只列命中的支付单',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(OUT_TRADE_NO.paid);
    await settled(server);
    const filters = { status: 'PAID', pay_channel: 'wechat_pay' };
    // The options show the dictionary names (the code without a row).
    await choose(scope(), LABEL.status, namePattern('payStatus', 'PAID', true));
    await choose(scope(), LABEL.channel, namePattern('channel', 'wechat_pay', true));
    await query();
    await waitFor(() => expect(server.tableReads(ORDERS, filters).length).toBeGreaterThan(0));
    await settled(server);
    const sent = server.tableReads(ORDERS, filters).at(-1)!;
    expect(sent.query).toMatchObject(filters);
    expect(sent.query['page'] ?? '1').toBe('1');
    expect(extraParams(sent.query, ORDER_PARAMS)).toEqual([]);
    await waitFor(() => expect(rowsOf(OUT_TRADE_NO.refunded)).toEqual([]));
    expect(rowsOf(OUT_TRADE_NO.paid)).toHaveLength(1);
    for (const number of [OUT_TRADE_NO.manual, OUT_TRADE_NO.closed])
      expect(rowsOf(number), number).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-FILTER#2] 商户单号 + 用户筛选：【查询】带 out_trade_no / user_id（原样、契约参数名），只列该支付单',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(OUT_TRADE_NO.paid);
    await settled(server);
    const filters = { out_trade_no: OUT_TRADE_NO.closed, user_id: USER.closed };
    await fill(textbox(scope(), LABEL.outTradeNo), OUT_TRADE_NO.closed);
    await fill(textbox(scope(), LABEL.user), USER.closed);
    await query();
    await waitFor(() => expect(server.tableReads(ORDERS, filters).length).toBeGreaterThan(0));
    await settled(server);
    const sent = server.tableReads(ORDERS, filters).at(-1)!;
    expect(sent.query).toMatchObject(filters);
    expect(sent.query['page'] ?? '1').toBe('1');
    expect(extraParams(sent.query, ORDER_PARAMS)).toEqual([]);
    await waitFor(() => expect(rowsOf(OUT_TRADE_NO.paid)).toEqual([]));
    expect(rowsOf(OUT_TRADE_NO.closed)).toHaveLength(1);
    for (const number of [OUT_TRADE_NO.manual, OUT_TRADE_NO.refunded])
      expect(rowsOf(number), number).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-13a-FILTER#3] 【重置】清空筛选：表格以不带筛选参数的请求重新读取，输入框清空，四张支付单重新列出',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(OUT_TRADE_NO.paid);
    await choose(scope(), LABEL.status, namePattern('payStatus', 'CLOSED', true));
    await fill(textbox(scope(), LABEL.outTradeNo), OUT_TRADE_NO.closed);
    await query();
    await waitFor(() => expect(rowsOf(OUT_TRADE_NO.paid)).toEqual([]));
    await settled(server);
    const before = server.orderReads().length;
    const tableBefore = server.tableReads(ORDERS).length;
    await click(action(scope(), RESET));
    await settle();
    await settled(server);
    // Some pages list again on 【重置】, others wait for 【查询】.
    if (rowsOf(OUT_TRADE_NO.paid).length === 0) {
      await query();
      await settled(server);
    }
    for (const number of Object.values(OUT_TRADE_NO))
      await waitFor(() => expect(rowsOf(number), number).toHaveLength(1));
    expect(textbox(scope(), LABEL.outTradeNo).value).toBe('');
    expect(server.tableReads(ORDERS).length, 'an unfiltered table read').toBeGreaterThan(
      tableBefore,
    );
    // Table reads after 【重置】 (not count reads) carry no filter at all.
    for (const sent of server
      .orderReads()
      .slice(before)
      .filter((read) => read.query['page_size'] !== '1'))
      for (const name of ORDER_FILTERS) expect(sent.query[name], `${name} cleared`).toBeUndefined();
  },
  FLOW_TIMEOUT,
);
