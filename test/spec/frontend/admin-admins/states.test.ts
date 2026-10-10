// @vitest-environment jsdom
import { act } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { ADMIN_PAGE, API_ERRORS, jsonResponse } from '../admin-data/fixtures.ts';
import { mount, page, requestSummary, tableWith } from './helpers.ts';

beforeEach(() => {
  installMediaQuery();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-07T10:00:00+08:00'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('[AC-F1-06i-STATES#1] 空响应在实际账号表格中显示 antd Empty', async () => {
  const h = mount(async () => jsonResponse(page([])));
  await waitFor(() => expect(h.requests).toHaveLength(1));
  await waitFor(() => {
    const main = screen.getByRole('main');
    expect(within(main).queryByRole('table')).not.toBeNull();
    expect(main.querySelector('.ant-table .ant-empty')).not.toBeNull();
  });
  const main = screen.getByRole('main');
  expect(main.querySelectorAll('[data-row-key]')).toHaveLength(0);
  expect(within(main).queryByRole('button', { name: '重试' })).toBeNull();
  expect(requestSummary(h.requests)).toEqual([
    { method: 'GET', path: '/admin/v1/admins?page=1&page_size=20' },
  ]);
});

it.each(['network', 'http', 'parse'] as const)(
  '[AC-F1-06i-STATES#2] %s 失败用 antd 反馈出错，手动重试重新请求并恢复数据',
  async (failure) => {
    let recovered = false;
    const h = mount(async () => {
      if (recovered) return jsonResponse(ADMIN_PAGE);
      if (failure === 'network') throw new Error('synthetic network failure');
      if (failure === 'http') return jsonResponse({ code: 50000, msg: '服务暂时不可用' }, 503);
      return new Response('{invalid-json', { status: 200 });
    });
    await waitFor(() => {
      const main = screen.getByRole('main');
      expect(main.querySelector('.ant-result, .ant-alert-error')).not.toBeNull();
      expect(within(main).queryByRole('button', { name: '重试' })).not.toBeNull();
    });
    const feedback = screen.getByRole('main').querySelector('.ant-result, .ant-alert-error');
    expect(feedback?.textContent).toMatch(/失败|出错|错误|异常|暂时不可用/);
    const beforeRetry = h.requests.length;
    expect(beforeRetry).toBeGreaterThan(0);
    recovered = true;
    await userEvent.click(within(screen.getByRole('main')).getByRole('button', { name: '重试' }));
    await tableWith('finance-jia');
    expect(h.requests).toHaveLength(beforeRetry + 1);
    expect(
      requestSummary(h.requests).every(
        (request) =>
          request.method === 'GET' && request.path === '/admin/v1/admins?page=1&page_size=20',
      ),
    ).toBe(true);
    expect(screen.getByRole('main').querySelector('.ant-result, .ant-alert-error')).toBeNull();
    expect(within(screen.getByRole('main')).queryByRole('button', { name: '重试' })).toBeNull();
  },
);

it('[AC-F1-06i-STATES#3] 10403 admin_permission_denied 显示无权限 Result，不显示表格', async () => {
  // Keep the shell's super snapshot: the server may revoke access after it was fetched.
  const h = mount(async () => jsonResponse(API_ERRORS[0], 403));
  await waitFor(() => {
    const main = screen.getByRole('main');
    expect(main.querySelector('.ant-result')).not.toBeNull();
    expect(main.querySelector('.ant-result')?.textContent).toMatch(
      /无权限|没有.*权限|暂无.*权限|无权/,
    );
  });
  const main = screen.getByRole('main');
  expect(h.requests.length).toBeGreaterThan(0);
  expect(within(main).queryByRole('table')).toBeNull();
  expect(main.querySelector('.ant-table')).toBeNull();
  expect(within(main).queryByRole('cell', { name: 'finance-jia' })).toBeNull();
});

it('[AC-F1-06i-STATES#4] 请求在途时表格显示 Spin，响应后退出加载状态并显示数据', async () => {
  const pending = Promise.withResolvers<Response>();
  const h = mount(() => pending.promise);
  try {
    await waitFor(() => expect(h.requests).toHaveLength(1));
    await waitFor(() => {
      const main = screen.getByRole('main');
      expect(main.querySelector('.ant-table')).not.toBeNull();
      // antd 5.29 InternalTable puts Spin in the table wrapper, beside its container.
      expect(main.querySelector('.ant-table-wrapper .ant-spin-spinning')).not.toBeNull();
    });
    await act(async () => pending.resolve(jsonResponse(ADMIN_PAGE)));
    await tableWith('finance-jia');
    await waitFor(() =>
      expect(screen.getByRole('main').querySelector('.ant-spin-spinning')).toBeNull(),
    );
  } finally {
    await act(async () => pending.resolve(jsonResponse(ADMIN_PAGE)));
  }
});
