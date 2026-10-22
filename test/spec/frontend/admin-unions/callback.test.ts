// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CALLBACK, GRANT, STATE, VERIFY, createServer, failure, ok, result } from './fixtures.ts';
import { main, mount, settle } from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function route(query: Record<string, string>): string {
  return `/unions/oauth-callback?${new URLSearchParams(query)}`;
}

it('[AC-F1-10ga-CALLBACK#1] StrictMode 回调 state 与 code 原样且只提交一次，带登录态不带动态码，code 不显示或记录', async () => {
  const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(globalThis.console, method),
  );
  const server = createServer();
  const { view } = await mount(server, {
    route: route({ state: STATE, code: GRANT }),
    strict: true,
  });
  await waitFor(() => expect(main().textContent).toMatch(/成功|已完成|已授权/));
  await settle();
  expect(server.requests('POST', CALLBACK)).toHaveLength(1);
  const request = server.requests('POST', CALLBACK)[0]!;
  expect(request.body).toEqual({ state: STATE, code: GRANT });
  expect(request.query).toEqual({});
  expect(request.headers.get('Authorization')).toBe('Bearer example-admin-token');
  expect(request.headers.has('X-Step-Up-Token')).toBe(false);
  expect(request.headers.has('Idempotency-Key')).toBe(false);
  expect(server.requests('POST', VERIFY)).toEqual([]);
  expect(server.log).toHaveLength(1);
  expect(document.body.textContent).not.toContain(GRANT);
  expect(document.body.innerHTML).not.toContain(GRANT);
  expect(JSON.stringify(logs.flatMap((spy) => spy.mock.calls))).not.toContain(GRANT);
  view.unmount();
  await settle();
  expect(server.requests('POST', CALLBACK)).toHaveLength(1);
});

it('[AC-F1-10ga-CALLBACK#2] 联盟返回 error 时提交 error 而非 code，显示失败原因', async () => {
  const server = createServer();
  server.once('POST', CALLBACK, () => ok({ ...result('failed'), error: 'access_denied' }));
  await mount(server, { route: route({ state: STATE, error: 'access_denied' }) });
  await waitFor(() => expect(main().textContent).toContain('access_denied'));
  expect(main().textContent).toMatch(/失败|拒绝/);
  expect(server.requests('POST', CALLBACK).map((r) => r.body)).toEqual([
    { state: STATE, error: 'access_denied' },
  ]);
  expect(server.requests('POST', VERIFY)).toEqual([]);
});

it('[AC-F1-10ga-CALLBACK#3] state 无效或属于别的管理员，20001 定位为链接失效提示', async () => {
  const server = createServer();
  server.once('POST', CALLBACK, () => failure(20001, { fields: ['state'] }));
  await mount(server, { route: route({ state: STATE, code: GRANT }) });
  await waitFor(() => expect(main().textContent).toMatch(/授权链接.*(?:失效|当前账号)/));
  expect(main().textContent).not.toContain(GRANT);
  expect(server.requests('POST', CALLBACK)).toHaveLength(1);
});

it('[AC-F1-10ga-CALLBACK#4] expired 会话明确显示过期，直接采用返回结果不二次查询', async () => {
  const server = createServer();
  server.terminal('expired');
  await mount(server, { route: route({ state: STATE, code: GRANT }) });
  await waitFor(() => expect(main().textContent).toMatch(/过期|失效/));
  expect(server.requests('GET')).toEqual([]);
  expect(server.requests('POST', CALLBACK)).toHaveLength(1);
});

it('[AC-F1-10ga-CALLBACK#5] 回调 10403 显示无权限，无动态码、无 code 回显', async () => {
  const server = createServer();
  server.once('POST', CALLBACK, () => failure(10403, { reason: 'admin_permission_denied' }));
  await mount(server, { route: route({ state: STATE, code: GRANT }) });
  await waitFor(() => expect(main().textContent).toMatch(/无权限|没有.*权限|权限不足/));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(main().textContent).not.toContain(GRANT);
  expect(server.requests('POST', VERIFY)).toEqual([]);
});

it('[AC-F1-10ga-CALLBACK#6] 回调网络失败不会自动再次发送一次性 code', async () => {
  const server = createServer();
  server.once('POST', CALLBACK, () => Promise.reject(new TypeError('offline')));
  await mount(server, { route: route({ state: STATE, code: GRANT }), strict: true });
  await waitFor(() => expect(main().textContent).toMatch(/失败|网络/));
  vi.useFakeTimers();
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
  } finally {
    vi.useRealTimers();
  }
  expect(server.requests('POST', CALLBACK)).toHaveLength(1);
  expect(main().textContent).not.toContain(GRANT);
});
