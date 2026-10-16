// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { admin_permission } from '../../../../packages/contracts-ts/src/index.ts';
import {
  getAdminMenuGroups,
  selectAdminMenuGroups,
} from '../../../../apps/admin/src/resources/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { isList } from './fixtures.ts';
import { breadcrumb, click, FLOW_TIMEOUT, listTable, mainElement, mount } from './helpers.ts';

// Oracle (task F1-06zd §1, decisions-r20 §1 / §7, flow-map §24): the 「运营」 group gains
// 「平台标识」 (menu id platform-icons) after 「版本管理」, shown by content.platform_icon alone.
const OPERATIONS = [
  ['pages', '首页配置'],
  ['pools', '商品池'],
  ['content', '内容管理'],
  ['messages', '消息模板'],
  ['app-versions', '版本管理'],
  ['platform-icons', '平台标识'],
] as const;

beforeEach(() => {
  installMediaQuery();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function sidebarLinks(): string[] {
  const navigation = screen.getByRole('navigation', { name: '主导航' });
  return within(navigation)
    .queryAllByRole('link')
    .map((link) => link.textContent?.trim() ?? '');
}

it('[AC-F1-06zd-MENU#1] 目录在「运营」组末尾加「平台标识」，只由 content.platform_icon 显示', () => {
  const operations = getAdminMenuGroups().find((group) => group.key === 'operations');
  expect(operations?.label).toBe('运营');
  expect(operations?.items.map((item) => [item.id, item.label])).toEqual(OPERATIONS);
  const entry = operations?.items.find((item) => (item.id as string) === 'platform-icons');
  expect(entry?.access).toEqual({ kind: 'any', permissions: ['content.platform_icon'] });

  const alone = selectAdminMenuGroups({ isSuper: false, permissions: ['content.platform_icon'] });
  expect(alone.map((group) => group.label)).toEqual(['运营', '数据', '系统']);
  expect(alone.flatMap((group) => group.items.map((item) => item.id))).toEqual([
    'platform-icons',
    'reports',
    'audit-logs',
  ]);

  // Every other permission point, the other content keys included, leaves the menu out.
  const others = admin_permission.filter((key) => key !== 'content.platform_icon');
  const without = selectAdminMenuGroups({ isSuper: false, permissions: [...others] });
  expect(without.flatMap((group) => group.items.map((item) => item.id))).not.toContain(
    'platform-icons',
  );
  for (const similar of ['content', 'content.*', 'CONTENT.PLATFORM_ICON', 'content.platform']) {
    const result = selectAdminMenuGroups({ isSuper: false, permissions: [similar] });
    expect(
      result.flatMap((group) => group.items.map((item) => item.id)),
      similar,
    ).not.toContain('platform-icons');
  }

  const superAdmin = selectAdminMenuGroups({ isSuper: true, permissions: [] });
  const superOperations = superAdmin.find((group) => group.key === 'operations');
  expect(superOperations?.items.map((item): string => item.id).at(-1)).toBe('platform-icons');
});

it(
  '[AC-F1-06zd-MENU#2] 持 content.platform_icon 的账号侧栏与面包屑显示平台标识并打开列表页；无此权限点不显示、不取数',
  async () => {
    const permitted = mount();
    await listTable();
    expect(sidebarLinks()).toEqual(['平台标识', '报表', '操作日志']);
    const navigation = screen.getByRole('navigation', { name: '主导航' });
    expect(within(navigation).getByRole('link', { name: '平台标识' }).getAttribute('href')).toBe(
      '/platform-icons',
    );
    expect(breadcrumb()).toEqual(['运营', '平台标识']);
    expect(permitted.server.log.filter(isList)).toHaveLength(1);
    permitted.unmount();

    // Every other permission point: no menu, and the address does not open the page either.
    const others = admin_permission.filter((key) => key !== 'content.platform_icon');
    const denied = mount(undefined, {
      permissionsProvider: async () => ({ isSuper: false, permissions: [...others] }),
    });
    await waitFor(() => expect(sidebarLinks()).toContain('版本管理'));
    expect(sidebarLinks()).not.toContain('平台标识');
    await waitFor(() => expect(breadcrumb()).not.toContain('平台标识'));
    expect(denied.server.log).toEqual([]);
    expect(mainElement().querySelector('.ant-table')).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-MENU#3] 超管侧栏「平台标识」紧跟「版本管理」，点击后进入平台标识页',
  async () => {
    const h = mount(undefined, {
      permissionsProvider: async () => ({ isSuper: true, permissions: [] }),
      initialRoute: { menuId: 'users' },
    });
    await waitFor(() => expect(sidebarLinks()).toContain('版本管理'));
    const links = sidebarLinks();
    expect(links.slice(links.indexOf('首页配置'), links.indexOf('首页配置') + 7)).toEqual([
      ...OPERATIONS.map(([, label]) => label),
      '分佣规则',
    ]);
    const navigation = screen.getByRole('navigation', { name: '主导航' });
    await click(within(navigation).getByRole('link', { name: '平台标识' }));
    await listTable();
    expect(breadcrumb()).toEqual(['运营', '平台标识']);
    expect(within(mainElement()).getByRole('heading', { name: '平台标识' }).tagName).toMatch(
      /^H[1-6]$/,
    );
    expect(h.server.log.filter(isList)).toHaveLength(1);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-06zd-MENU#4] 默认页接线不顶替调用方 renderPage，也不影响其余菜单的占位页',
  async () => {
    // Positive anchor first: the default page exists (red before the page is wired).
    const defaults = mount();
    await listTable();
    defaults.unmount();

    const custom = mount(undefined, {
      renderPage: (id) => createElement('div', null, `custom:${id}`),
    });
    await waitFor(() => expect(screen.queryByText('custom:platform-icons')).not.toBeNull());
    expect(custom.server.log).toEqual([]);
    expect(mainElement().querySelector('.ant-table')).toBeNull();
    custom.unmount();

    const other = mount(undefined, {
      permissionsProvider: async () => ({ isSuper: true, permissions: [] }),
      initialRoute: { menuId: 'app-versions' },
    });
    await waitFor(() => expect(screen.queryByText(/尚未接入/)).not.toBeNull());
    expect(other.server.log).toEqual([]);
  },
  FLOW_TIMEOUT,
);
