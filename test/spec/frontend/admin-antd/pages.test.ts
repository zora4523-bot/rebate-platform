// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { AdminShellOptions } from '../../../../apps/admin/src/shell-options.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { NO_PERMISSION_COPY } from '../admin-shell/fixtures.ts';

beforeEach(installMediaQuery);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const feedback = '.ant-result, .ant-empty, .ant-alert';

function mount(overrides: Partial<AdminShellOptions> = {}) {
  render(
    createAdminShell({
      router: 'memory',
      permissionsProvider: async () => ({ isSuper: false, permissions: [] }),
      account: { username: 'cs.xiaoli', displayName: '客服小狸' },
      environment: 'test',
      onLogout: vi.fn(),
      ...overrides,
    }),
  );
}

it('[AC-F1-06p-PAGES#1] 普通账号空权限页用 antd 反馈组件和操作按钮', async () => {
  mount();
  await waitFor(() => expect(screen.queryByText(NO_PERMISSION_COPY.title)).not.toBeNull());
  const main = within(screen.getByRole('main'));
  expect(main.getByText(NO_PERMISSION_COPY.title).closest(feedback)).not.toBeNull();
  expect(main.getByRole('button', { name: '刷新权限' }).matches('.ant-btn')).toBe(true);
  expect(main.getByRole('link', { name: '查看报表' }).closest('.ant-btn')).not.toBeNull();
});

it('[AC-F1-06p-PAGES#2] 权限加载失败用 antd 反馈组件和重试按钮', async () => {
  mount({ permissionsProvider: () => Promise.reject(new Error('synthetic permission failure')) });
  await waitFor(() => expect(screen.queryByText('权限加载失败')).not.toBeNull());
  const main = within(screen.getByRole('main'));
  expect(main.getByText('权限加载失败').closest(feedback)).not.toBeNull();
  expect(main.getByRole('button', { name: '重试' }).matches('.ant-btn')).toBe(true);
});

it('[AC-F1-06p-PAGES#3] 尚未接入页面用 antd 反馈组件呈现', async () => {
  mount({ initialRoute: { menuId: 'reports' } });
  await waitFor(() =>
    expect(screen.queryByText('该页面尚未接入，接入后在这里显示。')).not.toBeNull(),
  );
  const main = within(screen.getByRole('main'));
  expect(main.getByText('该页面尚未接入，接入后在这里显示。').closest(feedback)).not.toBeNull();
  for (const button of main.queryAllByRole('button')) expect(button.matches('.ant-btn')).toBe(true);
});
