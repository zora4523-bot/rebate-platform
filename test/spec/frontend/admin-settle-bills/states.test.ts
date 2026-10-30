// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BILL, LIST, createServer, failure, namePattern, tableRead } from './fixtures.ts';
import {
  EMPTY,
  FLOW_TIMEOUT,
  LABEL,
  LOAD_FAILED,
  RETRY,
  action,
  billRows,
  choose,
  click,
  listed,
  main,
  mount,
  query,
  settle,
  settled,
} from './helpers.ts';

// Only the table read (a list read under the current filters, see isTableQuery) is held or fails;
// count reads the page may send with other parameters are answered as usual.

function busy(): boolean {
  const area = main();
  return (
    area.querySelector('[aria-busy="true"], [role="progressbar"], .ant-spin-spinning') !== null ||
    /加载/.test(area.textContent ?? '')
  );
}
function unavailable(): Response {
  return failure(50001, undefined, '服务暂时不可用');
}

it(
  '[AC-F1-08d-STATE#1] 加载中：表格请求未返回时显示加载状态、没有账单行，返回后列出',
  async () => {
    const server = createServer();
    const release = server.hold('GET', LIST, undefined, tableRead());
    try {
      await mount(server);
      await waitFor(() => expect(server.tableReads().length).toBeGreaterThan(0));
      await settle();
      expect(busy(), 'a loading state in the main area').toBe(true);
      expect(billRows(BILL.issued)).toEqual([]);
    } finally {
      release();
    }
    await settled(server);
    await listed(BILL.issued);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-STATE#2] 出错可重试：表格请求失败显示出错与【重试】，重试成功后列出',
  async () => {
    const server = createServer();
    server.once('GET', LIST, unavailable, tableRead());
    await mount(server);
    await waitFor(() => expect(server.tableReads().length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(LOAD_FAILED));
    expect(billRows(BILL.issued)).toEqual([]);
    const reads = server.tableReads().length;
    await click(action(main(), RETRY));
    await waitFor(() => expect(server.tableReads().length).toBeGreaterThan(reads));
    await settled(server);
    await listed(BILL.issued);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-STATE#3] 再查失败不显示旧数据：换条件【查询】的表格请求失败时显示出错、不再显示之前的账单，重试后按该条件列出',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(BILL.issued);
    await settled(server);
    const filters = { status: 'settling' };
    server.once('GET', LIST, unavailable, tableRead(filters));
    const reads = server.tableReads(filters).length;
    await choose(main(), LABEL.status, namePattern('billStatus', 'settling', true));
    await query();
    await waitFor(() => expect(server.tableReads(filters).length).toBeGreaterThan(reads));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(LOAD_FAILED));
    for (const month of [BILL.issued, BILL.settling])
      expect(billRows(month), `no stale row ${month}`).toEqual([]);
    const failed = server.tableReads(filters).length;
    await click(action(main(), RETRY));
    await waitFor(() => expect(server.tableReads(filters).length).toBeGreaterThan(failed));
    await settled(server);
    await listed(BILL.settling);
    expect(billRows(BILL.issued)).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-STATE#4] 空列表：显示空状态，没有账单行，不发 GET 以外的请求',
  async () => {
    const server = createServer([]);
    await mount(server);
    await waitFor(() => expect(server.tableReads().length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(EMPTY));
    expect(billRows(BILL.issued)).toEqual([]);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);
