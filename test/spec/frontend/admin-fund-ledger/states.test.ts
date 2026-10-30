// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DAY, LIST, createServer, tableRead, unavailable } from './fixtures.ts';
import {
  EMPTY,
  FLOW_TIMEOUT,
  LOAD_FAILED,
  RETRY,
  action,
  click,
  dayRows,
  fillRange,
  listed,
  main,
  mount,
  query,
  settle,
  settled,
} from './helpers.ts';

// Only the table read (a list read under the current filters, see isTableQuery) is held or fails;
// count reads the page may send with page_size=1 are answered as usual.

const ALL_DAYS = [DAY.latest, DAY.late, DAY.older, DAY.bare] as const;

function busy(): boolean {
  const area = main();
  return (
    area.querySelector('[aria-busy="true"], [role="progressbar"], .ant-spin-spinning') !== null ||
    /加载/.test(area.textContent ?? '')
  );
}

it(
  '[AC-F1-08ga-STATE#1] 加载中：表格请求未返回时显示加载状态、没有快照行，返回后列出',
  async () => {
    const server = createServer();
    const release = server.hold('GET', LIST, undefined, tableRead());
    try {
      await mount(server);
      await waitFor(() => expect(server.tableReads().length).toBeGreaterThan(0));
      await settle();
      expect(busy(), 'a loading state in the main area').toBe(true);
      expect(dayRows(DAY.latest)).toEqual([]);
    } finally {
      release();
    }
    await settled(server);
    await listed(DAY.latest);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ga-STATE#2] 出错可重试：表格请求失败显示出错与【重试】、没有快照行，重试成功后列出',
  async () => {
    const server = createServer();
    const recover = server.always('GET', LIST, unavailable, tableRead());
    await mount(server);
    await waitFor(() => expect(server.tableReads().length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(LOAD_FAILED));
    expect(dayRows(DAY.latest)).toEqual([]);
    recover();
    const reads = server.tableReads().length;
    await click(action(main(), RETRY));
    await waitFor(() => expect(server.tableReads().length).toBeGreaterThan(reads));
    await settled(server);
    await listed(DAY.latest);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ga-STATE#3] 再查失败不显示旧数据：换日期区间【查询】的表格请求失败时显示出错、不再显示之前的快照行，重试后按该区间列出',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(DAY.latest);
    await settled(server);
    const filters = { date_from: '2026-10-26', date_to: '2026-10-28' };
    const recover = server.always('GET', LIST, unavailable, tableRead(filters));
    const reads = server.tableReads(filters).length;
    expect(main().textContent, 'no failure shown before the query').not.toMatch(LOAD_FAILED);
    await fillRange(filters.date_from, filters.date_to);
    await query();
    await waitFor(() => expect(server.tableReads(filters).length).toBeGreaterThan(reads));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(LOAD_FAILED));
    for (const day of ALL_DAYS) expect(dayRows(day), `no stale row ${day}`).toEqual([]);
    recover();
    const failed = server.tableReads(filters).length;
    await click(action(main(), RETRY));
    await waitFor(() => expect(server.tableReads(filters).length).toBeGreaterThan(failed));
    await settled(server);
    await listed(DAY.late);
    await listed(DAY.older);
    expect(dayRows(DAY.latest)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08ga-STATE#4] 空列表：显示空状态，没有快照行，也没有补出来的日期行',
  async () => {
    const server = createServer([]);
    await mount(server);
    await waitFor(() => expect(server.tableReads().length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(EMPTY));
    for (const day of [...ALL_DAYS, DAY.missing]) expect(dayRows(day), day).toEqual([]);
  },
  FLOW_TIMEOUT,
);
