// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BILL, LIST, createServer, failure } from './fixtures.ts';
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

function busy(): boolean {
  const area = main();
  return (
    area.querySelector('[aria-busy="true"], [role="progressbar"], .ant-spin-spinning') !== null ||
    /加载/.test(area.textContent ?? '')
  );
}

it(
  '[AC-F1-08d-STATE#1] 加载中：列表请求未返回时显示加载状态、没有账单行，返回后列出',
  async () => {
    const server = createServer();
    const release = server.hold('GET', LIST);
    try {
      await mount(server);
      await waitFor(() => expect(server.reads().length).toBeGreaterThan(0));
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
  '[AC-F1-08d-STATE#2] 出错可重试：列表请求失败显示出错与【重试】，重试成功后列出',
  async () => {
    const server = createServer();
    server.once('GET', LIST, () => failure(50001, undefined, '服务暂时不可用'));
    await mount(server);
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(LOAD_FAILED));
    expect(billRows(BILL.issued)).toEqual([]);
    const reads = server.reads().length;
    await click(action(main(), RETRY));
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(reads));
    await settled(server);
    await listed(BILL.issued);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08d-STATE#3] 再查失败不显示旧数据：换条件【查询】失败时显示出错、不再显示之前的账单，重试后按该条件列出',
  async () => {
    const server = createServer();
    await mount(server);
    await listed(BILL.issued);
    await settled(server);
    server.once('GET', LIST, () => failure(50001, undefined, '服务暂时不可用'));
    const reads = server.reads().length;
    await choose(main(), LABEL.status, /settling/);
    await query();
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(reads));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(LOAD_FAILED));
    for (const month of [BILL.issued, BILL.settling])
      expect(billRows(month), `no stale row ${month}`).toEqual([]);
    const failed = server.reads().length;
    await click(action(main(), RETRY));
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(failed));
    await settled(server);
    expect(server.reads().at(-1)!.query['status']).toBe('settling');
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
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(EMPTY));
    expect(billRows(BILL.issued)).toEqual([]);
    expect(server.others()).toEqual([]);
  },
  FLOW_TIMEOUT,
);
