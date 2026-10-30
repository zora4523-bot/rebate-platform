// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { LIST, NO, createServer, failure } from './fixtures.ts';
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
  openList,
  query,
  rowsOf,
  scope,
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
  '[AC-F1-08a-STATE#1] 加载中：列表请求未返回时显示加载状态、没有提现单行，返回后列出',
  async () => {
    const server = createServer();
    const release = server.hold('GET', LIST);
    try {
      await mount(server);
      await openList(server);
      await waitFor(() => expect(server.reads().length).toBeGreaterThan(0));
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
  '[AC-F1-08a-STATE#2] 出错可重试：列表请求失败显示出错与【重试】，重试成功后列出',
  async () => {
    const server = createServer();
    server.once('GET', LIST, () => failure(50001, undefined, '服务暂时不可用'));
    await mount(server);
    await openList(server);
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(LOAD_FAILED));
    expect(rowsOf(main(), [NO.pending])).toEqual([]);
    const reads = server.reads().length;
    await click(action(main(), RETRY));
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(reads));
    await settled(server);
    await openList(server, NO.pending);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-08a-STATE#3] 再查失败不显示旧数据：换条件【查询】失败时显示出错、不再显示之前的行，重试后按新条件列出',
  async () => {
    const server = createServer();
    await mount(server);
    await openList(server, NO.autoPaid);
    await settled(server);
    server.once('GET', LIST, () => failure(50001, undefined, '服务暂时不可用'));
    const reads = server.reads().length;
    await choose(scope(), LABEL.reviewMode, /^人工审核$/);
    await query();
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(reads));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(LOAD_FAILED));
    expect(rowsOf(main(), [NO.autoPaid]), 'no stale rows').toEqual([]);
    expect(rowsOf(main(), [NO.pending]), 'no stale rows').toEqual([]);
    const failed = server.reads().length;
    await click(action(main(), RETRY));
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(failed));
    await settled(server);
    expect(
      server
        .reads()
        .slice(failed)
        .some((read) => read.query['review_mode'] === 'manual'),
      'the retry keeps the new condition',
    ).toBe(true);
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
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(0));
    await settled(server);
    await waitFor(() => expect(scope().textContent).toMatch(EMPTY));
    expect(rowsOf(main(), [NO.pending])).toEqual([]);
    expect(server.writes()).toEqual([]);
  },
  FLOW_TIMEOUT,
);
