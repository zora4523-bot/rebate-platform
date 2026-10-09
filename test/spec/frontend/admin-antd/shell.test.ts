// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAdminShell } from '../../../../apps/admin/src/App.tsx';
import type { AdminShellOptions } from '../../../../apps/admin/src/shell-options.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { MENU } from '../admin-shell/fixtures.ts';

beforeEach(installMediaQuery);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(overrides: Partial<AdminShellOptions> = {}) {
  return render(
    createAdminShell({
      router: 'memory',
      permissionsProvider: async () => ({ isSuper: true, permissions: [] }),
      account: { username: 'super.admin', displayName: '超管' },
      environment: 'test',
      onLogout: vi.fn(),
      initialRoute: { menuId: 'users' },
      renderPage: (id) => createElement('div', null, `page:${id}`),
      ...overrides,
    }),
  );
}

async function ready() {
  await waitFor(() => expect(screen.queryByText('page:users')).not.toBeNull());
}

it('[AC-F1-06p-SHELL#1] 外壳使用 Layout、Sider、Header、Content 并保留页面地标', async () => {
  const { container } = mount();
  await ready();
  const main = screen.getByRole('main');
  const navigation = screen.getByRole('navigation', { name: '主导航' });
  const banner = screen.getByRole('banner');
  const layout = container.querySelector('.ant-layout');
  expect(layout).not.toBeNull();
  expect(layout?.contains(main)).toBe(true);
  expect(layout?.contains(navigation)).toBe(true);
  expect(layout?.contains(banner)).toBe(true);
  expect(navigation.closest('.ant-layout-sider')).not.toBeNull();
  expect(banner.closest('.ant-layout-header')).not.toBeNull();
  expect(main.closest('.ant-layout-content')).not.toBeNull();
});

it('[AC-F1-06p-SHELL#2] 主导航使用 Menu，所有菜单项保留名称和可访问链接，分组使用 antd 标题', async () => {
  mount();
  await ready();
  const navigation = screen.getByRole('navigation', { name: '主导航' });
  expect(navigation.querySelector('.ant-menu')).not.toBeNull();
  expect(within(navigation).queryAllByRole('menuitem')).toHaveLength(MENU.length);
  for (const [, id, label] of MENU) {
    const link = within(navigation).getByRole('link', { name: label });
    expect(link.getAttribute('href')).toBe(`/${id}`);
    expect(link.closest('[role="menuitem"]')).not.toBeNull();
    expect(link.closest('.ant-menu')).not.toBeNull();
  }
  expect(
    [...navigation.querySelectorAll('.ant-menu-item-group-title')].map((node) =>
      node.textContent?.trim(),
    ),
  ).toEqual([...new Set(MENU.map(([group]) => group))]);
});

it('[AC-F1-06p-SHELL#3] Menu 选中项随初始路由和点击导航更新', async () => {
  mount();
  await ready();
  const navigation = screen.getByRole('navigation', { name: '主导航' });
  const selected = () =>
    [...navigation.querySelectorAll('.ant-menu-item-selected')].map((node) =>
      within(node as HTMLElement)
        .getByRole('link')
        .getAttribute('href'),
    );
  expect(selected()).toEqual(['/users']);
  await userEvent.click(within(navigation).getByRole('link', { name: '订单查询' }));
  await waitFor(() => expect(screen.queryByText('page:orders')).not.toBeNull());
  await waitFor(() => expect(selected()).toEqual(['/orders']));
});

it('[AC-F1-06p-SHELL#4] 面包屑导航使用 Breadcrumb 并保留分组、菜单和子页顺序', async () => {
  mount({ initialRoute: { menuId: 'users', subpage: '用户 U10023' } });
  await ready();
  const navigation = screen.getByRole('navigation', { name: '面包屑' });
  expect(
    navigation.matches('.ant-breadcrumb') || navigation.querySelector('.ant-breadcrumb') !== null,
  ).toBe(true);
  expect(
    within(navigation)
      .getAllByRole('listitem')
      .map((node) => node.textContent?.trim()),
  ).toEqual(['用户与订单', '用户查询', '用户 U10023']);
});

it('[AC-F1-06p-SHELL#5] 顶栏用 Tag 展示测试环境，退出使用 antd 链接按钮', async () => {
  const onLogout = vi.fn();
  mount({ onLogout });
  await ready();
  const banner = within(screen.getByRole('banner'));
  expect(banner.getByText('测试环境').closest('.ant-tag')).not.toBeNull();
  const logout = banner.getByRole('button', { name: '退出' });
  expect(logout.matches('button.ant-btn.ant-btn-link')).toBe(true);
  await userEvent.click(logout);
  expect(onLogout).toHaveBeenCalledTimes(1);
});
