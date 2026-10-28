// @vitest-environment jsdom
import { waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { LIST, createServer, failure } from './fixtures.ts';
import {
  CHANNELS_TAB,
  FLOW_TIMEOUT,
  SMS_TAB,
  action,
  click,
  main,
  mount,
  openTab,
  panelOf,
  rowsOf,
  settle,
  settled,
  switchesOf,
} from './helpers.ts';

function busy(): boolean {
  const scope = main();
  return (
    scope.querySelector('[aria-busy="true"], [role="progressbar"]') !== null ||
    /加载/.test(scope.textContent ?? '')
  );
}

it(
  '[AC-F1-06zv-STATE#1] 加载中：列表请求未返回时显示加载状态、没有编码行，返回后列出',
  async () => {
    const server = createServer();
    const release = server.hold('GET', LIST);
    try {
      await mount(server);
      await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(1));
      await settle();
      expect(busy(), 'a loading state in the main area').toBe(true);
      expect(rowsOf(main(), ['WD_FAILED'])).toEqual([]);
    } finally {
      release();
    }
    await settled(server);
    await waitFor(() => expect(rowsOf(panelOf(CHANNELS_TAB), ['WD_FAILED'])).toHaveLength(1));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-STATE#2] 出错可重试：列表请求失败显示出错与【重试】，重试成功后列出',
  async () => {
    const server = createServer();
    server.once('GET', LIST, () => failure(50001, undefined, '服务暂时不可用'));
    await mount(server);
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(1));
    await settled(server);
    await waitFor(() => expect(main().textContent).toMatch(/失败|出错|错误/));
    expect(rowsOf(main(), ['WD_FAILED'])).toEqual([]);
    await click(action(main(), /重试/));
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(2));
    await settled(server);
    await waitFor(() => expect(rowsOf(panelOf(CHANNELS_TAB), ['WD_FAILED'])).toHaveLength(1));
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zv-STATE#3] 空列表：两个页签都显示空状态，没有开关与编辑入口',
  async () => {
    const server = createServer([]);
    await mount(server);
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(1));
    await settled(server);
    await openTab(CHANNELS_TAB);
    await waitFor(() =>
      expect(panelOf(CHANNELS_TAB).textContent).toMatch(/暂无|没有.*(?:编码|模板|数据|记录)/),
    );
    expect(switchesOf(main())).toEqual([]);
    await openTab(SMS_TAB);
    await waitFor(() =>
      expect(panelOf(SMS_TAB).textContent).toMatch(/暂无|没有.*(?:编码|模板|数据|记录|登记)/),
    );
    expect(rowsOf(panelOf(SMS_TAB), ['default'])).toEqual([]);
  },
  FLOW_TIMEOUT,
);
