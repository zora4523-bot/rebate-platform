// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  LIST,
  NOW,
  POLL,
  SESSION,
  START,
  VERIFY,
  createServer,
  failure,
  ok,
  result,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  advance,
  assertVerified,
  assertWrite,
  button,
  click,
  fill,
  loaded,
  main,
  mount,
  openOAuth,
  row,
  settle,
  stepUp,
  verify,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function popup() {
  const target = { closed: false, location: { href: '' }, close: vi.fn() };
  const open = vi.spyOn(window, 'open').mockReturnValue(target as unknown as Window);
  return { open, target };
}

it(
  '[AC-F1-10ga-OAUTH#1] 动态码后发起、打开 auth_url、pending 到成功，重读列表刷新到期时间',
  async () => {
    const { server } = await mount();
    const { open, target } = popup();
    const form = await openOAuth();
    await fill(within(form).getByLabelText(/原因|操作说明/), '到期前续期');
    const modal = await stepUp(form);
    expect(server.requests('POST', START)).toEqual([]);
    expect(open.mock.calls.some((call) => call[0] === SESSION.auth_url)).toBe(false);
    vi.useFakeTimers();
    await verify(modal);
    assertVerified(server);
    expect(server.requests('POST', START)).toHaveLength(1);
    const request = server.requests('POST', START)[0]!;
    expect(request.body).toEqual({ reason: '到期前续期' });
    assertWrite(request);
    expect(
      open.mock.calls.some((call) => call[0] === SESSION.auth_url) ||
        target.location.href === SESSION.auth_url ||
        screen.queryAllByRole('link').some((link) => {
          const anchor = link as HTMLAnchorElement;
          return anchor.href === SESSION.auth_url && anchor.target === '_blank';
        }),
    ).toBe(true);
    expect(
      open.mock.calls.every((call) => !['_self', '_parent', '_top'].includes(call[1] ?? '')),
    ).toBe(true);
    await advance(30_000);
    expect(server.requests('GET', POLL).length).toBeGreaterThanOrEqual(2);
    expect(server.requests('GET', LIST)).toHaveLength(2);
    expect(row('测试 OAuth 账号').textContent).toMatch(/2027[-/]0?4[-/]0?4/);
    expect(row('测试 OAuth 账号').textContent).toContain('00:30');
    expect(document.body.textContent).toMatch(/授权成功|重新授权成功|已授权|授权已完成/);
    for (const poll of server.requests('GET', POLL)) {
      expect(poll.query).toEqual({});
      expect(poll.headers.has('X-Step-Up-Token')).toBe(false);
    }
    const count = server.requests('GET', POLL).length;
    await advance(30_000);
    expect(server.requests('GET', POLL)).toHaveLength(count);
  },
  FLOW_TIMEOUT,
);

it.each(['failed', 'expired'] as const)(
  '[AC-F1-10ga-OAUTH#2] %s 显示终态并停止轮询，失败显示服务端原因',
  async (status) => {
    const server = createServer();
    server.terminal(status);
    await mount(server);
    popup();
    const modal = await stepUp(await openOAuth());
    vi.useFakeTimers();
    await verify(modal);
    await advance(30_000);
    expect(document.body.textContent).toMatch(status === 'failed' ? /失败/ : /过期|失效/);
    if (status === 'failed') expect(document.body.textContent).toContain('fixture_grant_declined');
    const count = server.requests('GET', POLL).length;
    expect(count).toBeGreaterThanOrEqual(2);
    await advance(30_000);
    expect(server.requests('GET', POLL)).toHaveLength(count);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10ga-OAUTH#3] 关闭等待对话框后停止轮询，包括迟到的成功响应之后',
  async () => {
    const server = createServer();
    server.terminal('pending');
    const release = server.hold('GET', POLL, () => ok(result('succeeded')));
    try {
      await mount(server);
      popup();
      const modal = await stepUp(await openOAuth());
      vi.useFakeTimers();
      await verify(modal);
      await advance(10_000);
      expect(server.requests('GET', POLL).length).toBeGreaterThan(0);
      const form = screen.getByRole('dialog', { name: /重新授权/ });
      const cancel = within(form).queryByRole('button', { name: '取消' });
      await click(cancel ?? button(form, /^(?:关闭|关闭.*授权|Close)$/));
      const count = server.requests('GET', POLL).length;
      release();
      await settle();
      await advance(30_000);
      expect(server.requests('GET', POLL)).toHaveLength(count);
      expect(screen.queryByRole('dialog', { name: /重新授权/ })).toBeNull();
    } finally {
      release();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10ga-OAUTH#8] 连续两次发起重新授权，每次先验证动态码且不复用上次令牌',
  async () => {
    const { server } = await mount();
    popup();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const modal = await stepUp(await openOAuth());
      expect(server.requests('POST', START)).toHaveLength(attempt - 1);
      assertVerified(server, attempt - 1);
      vi.useFakeTimers();
      await verify(modal);
      await advance(30_000);
      assertVerified(server, attempt);
      expect(server.requests('POST', START)).toHaveLength(attempt);
      assertWrite(server.requests('POST', START)[attempt - 1]!, `test-totp-${attempt}`);
      expect(document.body.textContent).toMatch(/授权成功|重新授权成功|已授权|授权已完成/);
      const form = screen.queryByRole('dialog', { name: /重新授权/ });
      if (form) {
        const cancel = within(form).queryByRole('button', { name: '取消' });
        await click(cancel ?? button(form, /^(?:关闭|关闭.*授权|完成|确定|Close)$/));
      }
      vi.useRealTimers();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10ga-OAUTH#4] 服务端一直 pending 时本地有轮询上限，过期后最终停止',
  async () => {
    const server = createServer();
    server.terminal('pending');
    const { setNow } = await mount(server);
    popup();
    const modal = await stepUp(await openOAuth());
    vi.useFakeTimers();
    await verify(modal);
    await advance(10_000);
    expect(server.requests('GET', POLL).length).toBeGreaterThan(0);
    // Beyond the session's ten-minute validity; allow a further full validity window to stop.
    setNow(NOW + 11 * 60_000);
    await advance(11 * 60_000);
    const count = server.requests('GET', POLL).length;
    await advance(60_000);
    expect(server.requests('GET', POLL)).toHaveLength(count);
    expect(document.body.textContent).toMatch(/过期|超时|失效|停止/);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10ga-OAUTH#5] 取消动态码后不发起授权，晚到的验证也不能写入',
  async () => {
    const server = createServer();
    const release = server.hold('POST', VERIFY);
    try {
      await mount(server);
      const { open } = popup();
      const modal = await stepUp(await openOAuth());
      await verify(modal);
      await waitFor(() => expect(server.requests('POST', VERIFY)).toHaveLength(1));
      await click(button(modal, '取消'));
      release();
      await settle();
      expect(server.requests('POST', START)).toEqual([]);
      expect(open.mock.calls.some((call) => call[0] === SESSION.auth_url)).toBe(false);
    } finally {
      release();
    }
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10ga-OAUTH#6] 授权成功后重读失败必须显示错误并移除旧列表，重试可恢复',
  async () => {
    const server = createServer();
    await mount(server);
    await loaded();
    popup();
    server.once('GET', LIST, () => Promise.reject(new TypeError('offline')));
    const modal = await stepUp(await openOAuth());
    vi.useFakeTimers();
    await verify(modal);
    await advance(30_000);
    vi.useRealTimers();
    expect(main().textContent).toMatch(/失败|网络/);
    expect(main().textContent).not.toContain('测试 OAuth 账号');
    expect(main().textContent).not.toContain('测试手工账号');
    await click(button(main(), /重试|重新加载/));
    await loaded();
    expect(server.requests('GET', LIST)).toHaveLength(3);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-10ga-OAUTH#7] 发起授权返回 10403 时提示权限不足，不打开授权地址或轮询',
  async () => {
    const server = createServer();
    server.once('POST', START, () => failure(10403, { reason: 'admin_permission_denied' }));
    await mount(server);
    const { open } = popup();
    await verify(await stepUp(await openOAuth()));
    await waitFor(() => expect(document.body.textContent).toMatch(/无权限|没有.*权限|权限不足/));
    expect(server.requests('GET', POLL)).toEqual([]);
    expect(open.mock.calls.some((call) => call[0] === SESSION.auth_url)).toBe(false);
  },
  FLOW_TIMEOUT,
);
