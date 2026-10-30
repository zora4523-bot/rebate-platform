// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BILL, FILTER_PARAMS, LIST_PARAMS, createServer, namePattern } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  LABEL,
  RESET,
  action,
  billRows,
  choose,
  click,
  extraParams,
  fillMonth,
  listed,
  main,
  monthField,
  mount,
  query,
  settle,
  settled,
} from './helpers.ts';

it(
  '[AC-F1-08d-FILTER#1] 账单月区间 + 账单状态筛选：【查询】带 bill_from / bill_to / status（契约参数名），从第 1 页起，只列命中的账单',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(BILL.issued);
    await settled(server);
    const filters = { bill_from: '2026-07', bill_to: '2026-08', status: 'settling' };
    await fillMonth(monthField('from'), '2026-07');
    await fillMonth(monthField('to'), '2026-08');
    // The option shows the dictionary name of the status (its code without a row).
    await choose(main(), LABEL.status, namePattern('billStatus', 'settling', true));
    await query();
    // The table read of the query (count reads with their own parameters aside).
    await waitFor(() => expect(server.tableReads(filters).length).toBeGreaterThan(0));
    await settled(server);
    const sent = server.tableReads(filters).at(-1)!;
    expect(sent.query).toMatchObject(filters);
    expect(sent.query['page'] ?? '1').toBe('1');
    expect(extraParams(sent.query, LIST_PARAMS)).toEqual([]);
    await waitFor(() => expect(billRows(BILL.issued)).toEqual([]));
    expect(billRows(BILL.settling)).toHaveLength(1);
    for (const month of [BILL.generating, BILL.settled]) expect(billRows(month), month).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-FILTER#2] 【重置】清空筛选：表格以不带筛选参数的请求重新读取，之后的请求不再带已清空的账单月，四张账单重新列出',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(BILL.issued);
    await fillMonth(monthField('from'), '2026-06');
    await fillMonth(monthField('to'), '2026-06');
    await choose(main(), LABEL.status, namePattern('billStatus', 'settled', true));
    await query();
    await waitFor(() => expect(billRows(BILL.issued)).toEqual([]));
    await settled(server);
    const before = server.reads().length;
    const tableBefore = server.tableReads().length;
    await click(action(main(), RESET));
    await settle();
    await settled(server);
    // Some pages list again on 【重置】, others wait for 【查询】.
    if (billRows(BILL.issued).length === 0) {
      await query();
      await settled(server);
    }
    for (const month of [BILL.generating, BILL.issued, BILL.settling, BILL.settled])
      await waitFor(() => expect(billRows(month), month).toHaveLength(1));
    expect(monthField('from').value).toBe('');
    expect(monthField('to').value).toBe('');
    const unfiltered = server.tableReads().length;
    expect(unfiltered, 'an unfiltered table read after 【重置】').toBeGreaterThan(tableBefore);
    const after = server.reads().slice(before);
    for (const sent of after) {
      expect(sent.query['bill_from'], 'bill_from cleared').toBeUndefined();
      expect(sent.query['bill_to'], 'bill_to cleared').toBeUndefined();
    }
    // Table reads (not count reads) carry no filter at all.
    for (const sent of after.filter((read) => read.query['page_size'] !== '1'))
      for (const name of FILTER_PARAMS) expect(sent.query[name], `${name} cleared`).toBeUndefined();
  },
  FLOW_TIMEOUT,
);
