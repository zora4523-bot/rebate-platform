// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DAY, FILTER_PARAMS, LIST_PARAMS, createServer } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  RESET,
  action,
  click,
  dateField,
  dayRows,
  extraParams,
  fieldError,
  fillRange,
  listed,
  main,
  mount,
  query,
  settle,
  settled,
} from './helpers.ts';

it(
  '[AC-F1-08ga-FILTER#1] 日期区间筛选：【查询】带 date_from / date_to（含两端），从第 1 页起，只列区间内写了快照的日子（缺日仍无行）',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(DAY.latest);
    await settled(server);
    const before = server.reads().length;
    await fillRange('2026-10-26', '2026-10-28');
    await query();
    const filtered = () =>
      server
        .reads()
        .slice(before)
        .filter((read) => read.query['date_from'] !== undefined);
    await waitFor(() => expect(filtered().length).toBeGreaterThan(0));
    await settled(server);
    const sent = filtered().at(-1)!;
    expect(sent.query['date_from']).toBe('2026-10-26');
    expect(sent.query['date_to']).toBe('2026-10-28');
    expect(sent.query['page'] ?? '1').toBe('1');
    expect(extraParams(sent.query, LIST_PARAMS)).toEqual([]);
    await waitFor(() => expect(dayRows(DAY.latest)).toEqual([]));
    await listed(DAY.late);
    await listed(DAY.older);
    expect(dayRows(DAY.bare)).toEqual([]);
    expect(dayRows(DAY.missing)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ga-FILTER#2] 【重置】清空日期区间：表格以不带 date_from / date_to 的请求重新读取，之后的请求不再带已清空的日期，四个快照日重新列出',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(DAY.latest);
    await fillRange('2026-10-28', '2026-10-29');
    await query();
    await waitFor(() => expect(dayRows(DAY.bare)).toEqual([]));
    await settled(server);
    const before = server.reads().length;
    await click(action(main(), RESET));
    await settle();
    await settled(server);
    // Some pages list again on 【重置】, others wait for 【查询】.
    if (dayRows(DAY.bare).length === 0) {
      await query();
      await settled(server);
    }
    for (const day of [DAY.latest, DAY.late, DAY.older, DAY.bare]) await listed(day);
    expect(dateField('from').value, 'start cleared').toBe('');
    expect(dateField('to').value, 'end cleared').toBe('');
    const after = server.reads().slice(before);
    expect(
      after.some((sent) => FILTER_PARAMS.every((name) => sent.query[name] === undefined)),
      'an unfiltered list read after 【重置】',
    ).toBe(true);
    for (const sent of after) {
      expect(sent.query['date_from'], 'date_from cleared').toBeUndefined();
      expect(sent.query['date_to'], 'date_to cleared').toBeUndefined();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ga-FILTER#3] 起始日期晚于截止日期：日期字段旁出现提示（前端拦下不发请求，或发出后收 20001 [date_from, date_to] 再提示），或控件自动调换后按调换后的区间请求；不得原样发出颠倒的区间而无任何提示',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(DAY.latest);
    await settled(server);
    const notices = () => `${fieldError(dateField('from'))} ${fieldError(dateField('to'))}`.trim();
    expect(notices(), 'no notice next to the dates before the query').toBe('');
    const before = server.reads().length;
    await fillRange('2026-10-29', '2026-10-25');
    await query();
    await settled(server);
    const sent = () => server.reads().slice(before);
    const reversed = () =>
      sent().filter((read) => {
        const from = read.query['date_from'];
        const to = read.query['date_to'];
        return from !== undefined && to !== undefined && from > to;
      });
    const swapped = () =>
      sent().filter((read) => {
        const from = read.query['date_from'];
        const to = read.query['date_to'];
        return from === '2026-10-25' && to === '2026-10-29';
      });
    const described = () =>
      sent()
        .map((read) => `${read.query['date_from'] ?? '-'}..${read.query['date_to'] ?? '-'}`)
        .join(', ');
    // Three accepted ways: a notice next to the dates (checked before sending, or after the
    // server's 20001), or the control swaps the ends and the swapped range is what goes out.
    await waitFor(() => {
      const noticed = notices() !== '';
      const swappedOnly = swapped().length > 0 && reversed().length === 0;
      expect(
        noticed || swappedOnly,
        `a notice next to the date fields, or only the swapped range sent (sent: ${described()})`,
      ).toBe(true);
    });
    await settled(server);
    if (notices() === '') {
      // The swapped range: read from page 1 with only the contract's parameters.
      expect(reversed(), 'the reversed range never went out').toEqual([]);
      const last = swapped().at(-1)!;
      expect(last.query['page'] ?? '1').toBe('1');
      expect(extraParams(last.query, LIST_PARAMS)).toEqual([]);
      for (const day of [DAY.latest, DAY.late, DAY.older, DAY.bare]) await listed(day);
      expect(dayRows(DAY.missing)).toEqual([]);
    }
  },
  FLOW_TIMEOUT,
);
