// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { NO, createServer, failure } from './fixtures.ts';
import {
  EMPTY,
  FLOW_TIMEOUT,
  LABEL,
  LOAD_FAILED,
  RETRY,
  action,
  choose,
  click,
  main,
  mount,
  occurrences,
  openList,
  query,
  readsWhere,
  rowsOf,
  scope,
  settle,
  settled,
  tableRead,
  textBesideRows,
} from './helpers.ts';

// Only the table's read (identified by its list parameters, tableRead) is held or fails; count
// reads of the status tabs, if the page makes them, are answered as usual.

function busy(): boolean {
  const area = main();
  return (
    area.querySelector('[aria-busy="true"], [role="progressbar"], .ant-spin-spinning') !== null ||
    /加载/.test(area.textContent ?? '')
  );
}
const unavailable = () => failure(50001, undefined, '服务暂时不可用');

it(
  '[AC-F1-08a-STATE#1] 加载中：表格请求未返回时显示加载状态、没有提现单行，返回后列出',
  async () => {
    const server = createServer();
    const release = server.holdWhere(tableRead());
    try {
      await mount(server);
      await openList(server);
      await waitFor(() => expect(readsWhere(server, tableRead()).length).toBeGreaterThan(0));
      await settle();
      expect(busy(), 'a loading state in the main area').toBe(true);
      expect(rowsOf(main(), [NO.pending])).toEqual([]);
    } finally {
      release();
    }
    await settled(server);
    await openList(server, NO.pending);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-STATE#2] 出错可重试：表格请求失败显示出错与【重试】，重试成功后列出',
  async () => {
    const server = createServer();
    server.onceWhere(tableRead(), unavailable);
    await mount(server);
    await openList(server);
    await waitFor(() => expect(readsWhere(server, tableRead()).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(textBesideRows(main())).toMatch(LOAD_FAILED));
    expect(rowsOf(main(), [NO.pending])).toEqual([]);
    const reads = readsWhere(server, tableRead()).length;
    await click(action(main(), RETRY));
    await waitFor(() => expect(readsWhere(server, tableRead()).length).toBeGreaterThan(reads));
    await settled(server);
    await openList(server, NO.pending);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-STATE#3] 再查失败不显示旧数据：换条件【查询】后表格请求失败时新出现出错提示、不再显示之前的行，重试后按新条件列出',
  async () => {
    const server = createServer();
    await mount(server);
    await openList(server, NO.autoPaid);
    await settled(server);
    const manual = tableRead({ review_mode: 'manual' });
    server.onceWhere(manual, unavailable);
    const notices = occurrences(textBesideRows(main()), LOAD_FAILED);
    await choose(scope(), LABEL.reviewMode, /^人工审核$/);
    await query();
    await waitFor(() => expect(readsWhere(server, manual).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() =>
      expect(
        occurrences(textBesideRows(main()), LOAD_FAILED),
        'a failure notice that was not there before',
      ).toBeGreaterThan(notices),
    );
    expect(rowsOf(main(), [NO.autoPaid]), 'no stale rows').toEqual([]);
    expect(rowsOf(main(), [NO.pending]), 'no stale rows').toEqual([]);
    const failed = readsWhere(server, manual).length;
    await click(action(main(), RETRY));
    await waitFor(() => expect(readsWhere(server, manual).length).toBeGreaterThan(failed));
    await settled(server);
    await waitFor(() => expect(rowsOf(scope(), [NO.pending])).toHaveLength(1));
    expect(rowsOf(scope(), [NO.autoPaid])).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-STATE#4] 空列表：显示空状态，没有提现单行，不发 GET 以外的请求',
  async () => {
    const server = createServer([]);
    await mount(server);
    await openList(server);
    await waitFor(() => expect(readsWhere(server, tableRead()).length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(scope().textContent).toMatch(EMPTY));
    expect(rowsOf(main(), [NO.pending])).toEqual([]);
    expect(server.writes()).toEqual([]);
  },
  FLOW_TIMEOUT,
);
