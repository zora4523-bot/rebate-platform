// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { ADMIN_ONE, ADMIN_PAGE, jsonResponse } from '../admin-data/fixtures.ts';
import { cellsFor, mount, page, requestSummary, tableWith, type Account } from './helpers.ts';

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

it('[AC-F1-06i-LIST#1] 默认 admins 页按契约取数，展示七列、超管及普通账号映射且只读', async () => {
  const accounts = [...ADMIN_PAGE.data.items, ADMIN_ONE.data];
  const h = mount(async () => jsonResponse(page(accounts)));
  const table = await tableWith('finance-jia');
  const main = screen.getByRole('main');
  expect(main.querySelector('.ant-table')?.contains(table)).toBe(true);
  expect(requestSummary(h.requests)).toEqual([
    { method: 'GET', path: '/admin/v1/admins?page=1&page_size=20' },
  ]);
  expect(within(main).getByRole('heading', { name: '后台账号与权限' })).toBeTruthy();
  const note = within(main).getByRole('note');
  expect(note.matches('.ant-alert-info') || note.closest('.ant-alert-info') !== null).toBe(true);
  expect(note.textContent?.trim()).not.toBe('');
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((node) => node.textContent?.trim()),
  ).toEqual(['账号', '类型', '权限点', '动态码', '验证手机号', '状态', '创建时间']);
  expect(cellsFor(table, 'finance-jia')).toEqual([
    'finance-jia',
    '普通账号',
    '2 项',
    '已绑定',
    '138****5678',
    '启用',
    '2026-10-05',
  ]);
  expect(cellsFor(table, 'ops-yi')).toEqual([
    'ops-yi',
    '普通账号',
    '0 项',
    '未绑定',
    '未登记',
    '已锁定 至 10:30',
    '2026-10-06',
  ]);
  expect(cellsFor(table, 'owner')).toEqual([
    'owner',
    '超级管理员',
    '全部',
    '已绑定',
    '139****0000',
    '启用',
    '2026-10-01',
  ]);
  for (const account of accounts) {
    expect(
      within(table)
        .getByRole('cell', { name: account.username })
        .closest('tr')
        ?.getAttribute('data-row-key'),
    ).toBe(account.admin_id);
  }
  for (const name of ['名称', '最近登录', '操作']) {
    expect(within(main).queryByRole('columnheader', { name })).toBeNull();
  }
  expect(
    within(main).queryByRole('button', { name: /新建账号|权限设置|停用|启用|查询|重置/ }),
  ).toBeNull();
  expect(within(main).queryByRole('link', { name: /新建账号|权限设置|停用|启用/ })).toBeNull();
  expect(within(main).queryByRole('textbox')).toBeNull();
});

it('[AC-F1-06i-LIST#2] 停用、已过期及恰好到期的锁定回到账号状态，时间按北京时间展示', async () => {
  // Boundary variants of the contract example; UTC timestamps deliberately cross a date boundary.
  const accounts: Account[] = [
    { ...ADMIN_ONE.data, username: 'disabled-account', status: 'disabled' },
    {
      ...ADMIN_ONE.data,
      admin_id: ADMIN_PAGE.data.items[0]!.admin_id,
      username: 'expired-lock',
      locked_until: '2026-10-07T01:59:59Z',
    },
    {
      ...ADMIN_ONE.data,
      admin_id: ADMIN_PAGE.data.items[1]!.admin_id,
      username: 'at-boundary',
      locked_until: '2026-10-07T02:00:00Z',
    },
    {
      ...ADMIN_ONE.data,
      admin_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5b03',
      username: 'utc-lock',
      locked_until: '2026-10-07T02:30:00Z',
      created_at: '2026-10-04T17:00:00Z',
    },
  ];
  mount(async () => jsonResponse(page(accounts)));
  const table = await tableWith('disabled-account');
  expect(cellsFor(table, 'disabled-account')[5]).toBe('已停用');
  expect(cellsFor(table, 'expired-lock')[5]).toBe('启用');
  expect(cellsFor(table, 'at-boundary')[5]).toBe('启用');
  expect(cellsFor(table, 'utc-lock').slice(5)).toEqual(['已锁定 至 10:30', '2026-10-05']);
});

it('[AC-F1-06i-PAGE#1] antd 分页显示总数，第二页重新 GET 并替换首屏数据', async () => {
  const first: Account[] = Array.from({ length: 20 }, (_, index) => ({
    ...ADMIN_ONE.data,
    admin_id: `0199a3b4-5c6d-7e8f-9a0b-${String(index + 1).padStart(12, '0')}`,
    username: `page-one-${index + 1}`,
  }));
  const h = mount(async (request) => {
    const current = new URL(request.url).searchParams.get('page');
    return jsonResponse(current === '2' ? page([ADMIN_ONE.data], 21, 2) : page(first, 21));
  });
  await tableWith('page-one-1');
  const main = screen.getByRole('main');
  expect(within(main).getByText('共 21 条')).toBeTruthy();
  const pagination = main.querySelector<HTMLElement>('.ant-pagination');
  expect(pagination).not.toBeNull();
  await userEvent.click(within(pagination!).getByText('2', { exact: true }));
  const table = await tableWith('owner');
  expect(requestSummary(h.requests)).toEqual([
    { method: 'GET', path: '/admin/v1/admins?page=1&page_size=20' },
    { method: 'GET', path: '/admin/v1/admins?page=2&page_size=20' },
  ]);
  expect(within(table).queryByRole('cell', { name: 'page-one-1' })).toBeNull();
  expect(
    within(table)
      .getAllByRole('row')
      .filter((row) => row.hasAttribute('data-row-key')),
  ).toHaveLength(1);
  expect(within(main).getByText('共 21 条')).toBeTruthy();
  expect(main.querySelector('.ant-pagination-item-active')?.textContent?.trim()).toBe('2');
});

it('[AC-F1-06i-LIST#3] 默认页面接线只对超管 admins 生效，保留调用方 renderPage 与其余占位页', async () => {
  // The new default page is the positive anchor; the following existing shell guarantees
  // must survive wiring it in. This case is also red before the page exists.
  const defaults = mount();
  await tableWith('finance-jia');
  defaults.unmount();

  const custom = mount(undefined, {
    renderPage: (id) => createElement('div', null, `custom:${id}`),
  });
  await waitFor(() => expect(screen.queryByText('custom:admins')).not.toBeNull());
  expect(custom.requests).toHaveLength(0);
  expect(within(screen.getByRole('main')).queryByRole('table')).toBeNull();
  custom.unmount();

  const other = mount(undefined, { initialRoute: { menuId: 'users' } });
  await waitFor(() => expect(screen.queryByText(/尚未接入/)).not.toBeNull());
  expect(other.requests).toHaveLength(0);
  other.unmount();

  const ordinary = mount(undefined, {
    permissionsProvider: async () => ({ isSuper: false, permissions: ['fund.view'] }),
  });
  await waitFor(() => {
    expect(screen.queryByRole('link', { name: '余额流水' })).not.toBeNull();
  });
  expect(
    within(screen.getByRole('navigation', { name: '主导航' })).queryByRole('link', {
      name: '后台账号与权限',
    }),
  ).toBeNull();
  expect(within(screen.getByRole('main')).queryByRole('table')).toBeNull();
  expect(ordinary.requests).toHaveLength(0);
});
