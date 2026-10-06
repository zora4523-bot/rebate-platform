// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createAdminShell, type AdminShellOptions } from '../../../../apps/admin/src/shell.ts';
import { CASES, labels, NO_PERMISSION_COPY } from './fixtures.ts';

beforeEach(() => {
  // jsdom supplies no media-query API; this is a browser boundary fixture, not an antd mock.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

function options(overrides: Partial<AdminShellOptions> = {}): AdminShellOptions {
  return {
    permissionsProvider: async () => ({ isSuper: false, permissions: [] }),
    account: { username: 'cs.xiaoli', displayName: '客服小狸' },
    environment: 'test',
    onLogout: vi.fn(),
    renderPage: (id) => createElement('div', null, `page:${id}`),
    ...overrides,
  };
}

for (const sample of CASES) {
  it(`[AC-F1-06e-SHELL#1] ${sample.name} 的真实侧栏只渲染获准菜单且保留顺序`, async () => {
    const provider = vi.fn(async () => sample.snapshot);
    render(createAdminShell(options({ permissionsProvider: provider })));
    await waitFor(() =>
      expect(screen.queryByRole('navigation', { name: '主导航' })).not.toBeNull(),
    );
    const sidebar = within(screen.getByRole('navigation', { name: '主导航' }));
    await waitFor(() =>
      expect(sidebar.queryAllByRole('link').map((node) => node.textContent?.trim())).toEqual(
        labels(sample.ids),
      ),
    );
    expect(sidebar.getAllByRole('heading').map((node) => node.textContent?.trim())).toEqual(
      sample.groups,
    );
    expect(screen.getByText('凑狸管理后台')).toBeDefined();
    expect(provider).toHaveBeenCalled();
    if (sample.snapshot.isSuper) expect(screen.queryByText(NO_PERMISSION_COPY.title)).toBeNull();
  });
}

it('[AC-F1-06e-SHELL#2] 零权限登录落暂无权限页，主文案与两个入口符合画板', async () => {
  render(createAdminShell(options()));
  await waitFor(() => expect(screen.queryByText(NO_PERMISSION_COPY.title)).not.toBeNull());
  const main = within(screen.getByRole('main'));
  expect(main.getByText(NO_PERMISSION_COPY.welcome)).toBeDefined();
  expect(main.getByText(NO_PERMISSION_COPY.description)).toBeDefined();
  expect(main.getByRole('button', { name: '刷新权限' })).toBeDefined();
  expect(main.getByRole('link', { name: '查看报表' })).toBeDefined();
  expect(main.queryByText('page:users')).toBeNull();
  await userEvent.click(main.getByRole('link', { name: '查看报表' }));
  await waitFor(() => expect(screen.queryByText('page:reports')).not.toBeNull());
  expect(
    within(screen.getByRole('navigation', { name: '面包屑' }))
      .getAllByRole('listitem')
      .map((node) => node.textContent?.trim()),
  ).toEqual(['数据', '报表']);
});

it('[AC-F1-06e-SHELL#3] 刷新权限重新调用注入 provider 并显示新获准菜单', async () => {
  let granted = false;
  const provider = vi.fn<AdminShellOptions['permissionsProvider']>(async () => ({
    isSuper: false,
    permissions: granted ? ['user.lookup'] : [],
  }));
  render(createAdminShell(options({ permissionsProvider: provider })));
  await waitFor(() => expect(screen.queryByRole('button', { name: '刷新权限' })).not.toBeNull());
  const previousCalls = provider.mock.calls.length;
  granted = true;
  await userEvent.click(screen.getByRole('button', { name: '刷新权限' }));
  await waitFor(() => expect(provider.mock.calls.length).toBeGreaterThan(previousCalls));
  const sidebar = within(screen.getByRole('navigation', { name: '主导航' }));
  await waitFor(() =>
    expect(sidebar.queryAllByRole('link').map((node) => node.textContent?.trim())).toEqual([
      '用户查询',
      '报表',
      '操作日志',
    ]),
  );
  await userEvent.click(sidebar.getByRole('link', { name: '用户查询' }));
  await waitFor(() => expect(screen.queryByText('page:users')).not.toBeNull());
  expect(screen.queryByText(NO_PERMISSION_COPY.title)).toBeNull();
});

it('[AC-F1-06e-SHELL#4] 面包屑依次展示分组、菜单、子页，切换菜单清除旧子页', async () => {
  render(
    createAdminShell(
      options({
        permissionsProvider: async () => ({
          isSuper: false,
          permissions: ['user.lookup', 'order.view'],
        }),
        initialRoute: { menuId: 'users', subpage: '用户 U10023' },
      }),
    ),
  );
  await waitFor(() => expect(screen.queryByRole('navigation', { name: '面包屑' })).not.toBeNull());
  const crumbs = () =>
    within(screen.getByRole('navigation', { name: '面包屑' }))
      .queryAllByRole('listitem')
      .map((node) => node.textContent?.trim());
  await waitFor(() => expect(crumbs()).toEqual(['用户与订单', '用户查询', '用户 U10023']));
  const sidebar = within(screen.getByRole('navigation', { name: '主导航' }));
  await userEvent.click(sidebar.getByRole('link', { name: '订单查询' }));
  await waitFor(() => expect(crumbs()).toEqual(['用户与订单', '订单查询']));
  expect(screen.getByText('page:orders')).toBeDefined();
});

for (const environment of ['test', 'staging', 'development', 'production'] as const) {
  it(`[AC-F1-06e-SHELL#5] ${environment} 顶栏显示账号、退出和正确的环境标签`, async () => {
    const onLogout = vi.fn();
    render(createAdminShell(options({ environment, onLogout })));
    await waitFor(() => expect(screen.queryByRole('banner')).not.toBeNull());
    const banner = within(screen.getByRole('banner'));
    expect(banner.getByText('客服小狸')).toBeDefined();
    expect(banner.queryByText('测试环境') !== null).toBe(environment !== 'production');
    await userEvent.click(banner.getByRole('button', { name: '退出' }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
}

it('[AC-F1-06e-SHELL#6] 权限由注入 provider 提供，壳不主动请求未入契约的后台接口', async () => {
  const fetch = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  const xhr = vi.spyOn(XMLHttpRequest.prototype, 'open');
  const provider = vi.fn(async () => ({ isSuper: false, permissions: [] }));
  render(createAdminShell(options({ permissionsProvider: provider })));
  await waitFor(() => expect(screen.queryByRole('button', { name: '刷新权限' })).not.toBeNull());
  await userEvent.click(screen.getByRole('button', { name: '刷新权限' }));
  await waitFor(() => expect(provider.mock.calls.length).toBeGreaterThan(1));
  expect(fetch).not.toHaveBeenCalled();
  expect(xhr).not.toHaveBeenCalled();
});
