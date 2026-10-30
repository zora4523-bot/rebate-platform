// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BILL, FILTER_PARAMS, LIST_PARAMS, createServer } from './fixtures.ts';
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
    const before = server.reads().length;
    await fillMonth(monthField('from'), '2026-07');
    await fillMonth(monthField('to'), '2026-08');
    // No admin_dict row for the bill status: the option shows its code.
    await choose(main(), LABEL.status, /settling/);
    await query();
    const filtered = () =>
      server
        .reads()
        .slice(before)
        .filter((read) => read.query['status'] !== undefined);
    await waitFor(() => expect(filtered().length).toBeGreaterThan(0));
    await settled(server);
    const sent = filtered().at(-1)!;
    expect(sent.query).toMatchObject({
      bill_from: '2026-07',
      bill_to: '2026-08',
      status: 'settling',
    });
    expect(sent.query['page'] ?? '1').toBe('1');
    expect(extraParams(sent.query, LIST_PARAMS)).toEqual([]);
    await waitFor(() => expect(billRows(BILL.issued)).toEqual([]));
    expect(billRows(BILL.settling)).toHaveLength(1);
    for (const month of [BILL.generating, BILL.settled]) expect(billRows(month), month).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-FILTER#2] 【重置】清空筛选：以不带筛选参数的请求重新读取，之后的请求不再带已清空的条件，四张账单重新列出',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(BILL.issued);
    await fillMonth(monthField('from'), '2026-06');
    await fillMonth(monthField('to'), '2026-06');
    await choose(main(), LABEL.status, /settled/);
    await query();
    await waitFor(() => expect(billRows(BILL.issued)).toEqual([]));
    await settled(server);
    const before = server.reads().length;
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
    const after = server.reads().slice(before);
    expect(
      after.some((sent) => FILTER_PARAMS.every((name) => sent.query[name] === undefined)),
      'an unfiltered list read after 【重置】',
    ).toBe(true);
    for (const sent of after) {
      expect(sent.query['bill_from'], 'bill_from cleared').toBeUndefined();
      expect(sent.query['bill_to'], 'bill_to cleared').toBeUndefined();
      expect(sent.query['status'], 'status cleared').toBeUndefined();
    }
  },
  FLOW_TIMEOUT,
);
