// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EMPTY, ORDER_NUMBER, createServer, failure } from './search-fixtures.ts';
import {
  FLOW_TIMEOUT,
  click,
  fill,
  input,
  key,
  mount,
  region,
  searchButton,
  settled,
  submit,
} from './search-helpers.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it(
  '[AC-F1-07h-SUBMIT#1] 只输入不搜索，回车只发一次 GET 且唯一参数 q 去除首尾空白',
  async () => {
    const { server, directFetch } = await mount();
    const box = await input();
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.change(box, { target: { value: `  ${ORDER_NUMBER} \t` } });
      box.focus();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    vi.useRealTimers();
    await settled(server);
    expect(server.log).toHaveLength(0);
    await key('{Enter}');
    await waitFor(() => expect(server.log).toHaveLength(1));
    await settled(server);
    expect(server.log[0]).toMatchObject({
      method: 'GET',
      query: { q: ORDER_NUMBER },
      body: undefined,
    });
    expect(server.log[0]!.headers.get('Authorization')).toBe('Bearer example-admin-token');
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-SUBMIT#2] 点放大镜只请求一次且只带去空白后的 q',
  async () => {
    const { server } = await mount();
    await submit(`  ${ORDER_NUMBER}  `, 'button');
    await waitFor(() => expect(server.log).toHaveLength(1));
    await settled(server);
    expect(server.log[0]).toMatchObject({ method: 'GET', query: { q: ORDER_NUMBER } });
    expect(server.log).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-SUBMIT#3] 空串和全空白无论回车或点放大镜都不请求',
  async () => {
    const { server } = await mount();
    await fill('');
    await key('{Enter}');
    await fill('   \t');
    await key('{Enter}');
    await click(await searchButton());
    await settled(server);
    expect(server.log).toHaveLength(0);
    expect(screen.queryByRole('listbox')).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-SUBMIT#4] 请求在途显示 Input.Search loading，重复回车及点击只发送一次',
  async () => {
    const server = createServer();
    const release = server.hold();
    await mount(server);
    try {
      await submit(ORDER_NUMBER);
      await waitFor(() => expect(server.log).toHaveLength(1));
      expect((await region()).querySelector('.ant-btn-loading')).not.toBeNull();
      await key('{Enter}{Enter}');
      await click(await searchButton());
      expect(server.log).toHaveLength(1);
    } finally {
      await act(async () => release());
    }
    await settled(server);
    await waitFor(async () =>
      expect((await region()).querySelector('.ant-btn-loading')).toBeNull(),
    );
    expect(server.log).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-SUBMIT#5] 服务端 20001 fields q 在输入框旁提示并保留输入，修正后可重试',
  async () => {
    const server = createServer(EMPTY);
    server.once(() => failure(20001, { fields: ['q'] }, '参数错误'));
    await mount(server);
    await submit(ORDER_NUMBER);
    await waitFor(async () => expect((await region()).textContent).toMatch(/参数|输入|长度|64/));
    expect((await input()).value).toContain(ORDER_NUMBER);
    expect(screen.queryByText(/没有找到/)).toBeNull();
    await submit('x');
    await waitFor(() => expect(server.log).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText(/没有找到/)).not.toBeNull());
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-SUBMIT#6] 网络失败通过 message.error 提示并保留输入',
  async () => {
    const server = createServer();
    server.once(() => Promise.reject(new Error('offline test transport')));
    await mount(server);
    await submit(ORDER_NUMBER);
    await waitFor(() => {
      const message = document.querySelector('.ant-message-error');
      expect(message).not.toBeNull();
      expect(message!.textContent).toMatch(/网络|失败|重试|连接/);
    });
    expect((await input()).value).toContain(ORDER_NUMBER);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(server.log).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-SUBMIT#7] HTTP 500 通过 message.error 提示并保留输入',
  async () => {
    const server = createServer();
    server.once(() => new Response('unavailable', { status: 500 }));
    await mount(server);
    await submit(ORDER_NUMBER);
    await waitFor(() => expect(document.querySelector('.ant-message-error')).not.toBeNull());
    expect((await input()).value).toContain(ORDER_NUMBER);
    expect(screen.queryByText(/没有找到/)).toBeNull();
    expect(server.log).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-SUBMIT#8] 1 字与去空白后 64 字都可提交，不在前端按号码形状拒绝',
  async () => {
    const server = createServer(EMPTY);
    await mount(server);
    await submit('x');
    await waitFor(() => expect(screen.queryByText(/没有找到/)).not.toBeNull());
    await key('{Escape}');
    await submit(`  ${'x'.repeat(64)}  `);
    await waitFor(() => expect(server.log).toHaveLength(2));
    expect(server.log.map((request) => request.query)).toEqual([{ q: 'x' }, { q: 'x'.repeat(64) }]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07h-SUBMIT#9] 超过 64 字提示输入错误且不静默截断为另一个号码',
  async () => {
    const server = createServer(EMPTY);
    server.once(() => failure(20001, { fields: ['q'] }, '参数错误'));
    await mount(server);
    const query = 'x'.repeat(65);
    await submit(query);
    // Either local validation or the contract's 20001 is allowed; truncation is not.
    await waitFor(async () => expect((await region()).textContent).toMatch(/参数|长度|64|过长/));
    expect((await input()).value).toBe(query);
    expect(screen.queryByText(/没有找到/)).toBeNull();
    for (const request of server.log) expect(request.query).toEqual({ q: query });
  },
  FLOW_TIMEOUT,
);
