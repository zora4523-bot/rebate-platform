// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LIST, VERIFY, createServer, failure, item, rows } from './fixtures.ts';
import { button, click, loaded, mainElement, mount, row, settled } from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function column(current: HTMLElement, name: RegExp): HTMLElement {
  const table = current.closest<HTMLElement>('table, [role="table"]');
  expect(table, 'semantic list table').not.toBeNull();
  const index = within(table!)
    .getAllByRole('columnheader')
    .findIndex((heading) => name.test(heading.textContent ?? ''));
  expect(index, `column ${String(name)}`).toBeGreaterThanOrEqual(0);
  const result = within(current).getAllByRole('cell')[index];
  expect(result).toBeDefined();
  return result!;
}

it('[AC-F1-10h-LIST#1] 默认 /app-versions 路由接入真实页面，不停留在菜单占位', async () => {
  const { server } = await mount(createServer(), { defaultRoute: true });
  await loaded();
  expect(server.requests('GET', LIST)).toHaveLength(1);
});

it('[AC-F1-10h-LIST#2] 不分页，按端渠道列出全部版本、商店登记与更新时间，读取不需动态码', async () => {
  const { server, directFetch } = await mount();
  await loaded();
  let previous: HTMLElement | undefined;
  for (const entry of rows()) {
    const current = row(entry.latest_version);
    if (previous)
      expect(previous.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
        0,
      );
    previous = current;
    const cells = within(current).getAllByRole('cell');
    // No fixed Chinese platform/channel translations: both identifying cells must be populated.
    expect(cells[0]?.textContent?.trim()).toBeTruthy();
    expect(cells[1]?.textContent?.trim()).toBeTruthy();
    expect(column(current, /最新版本/).textContent).toContain(entry.latest_version);
    if (entry.min_supported_version !== null)
      expect(column(current, /最低支持版本/).textContent).toContain(entry.min_supported_version);
    if (entry.recommended_version !== null)
      expect(column(current, /推荐版本/).textContent).toContain(entry.recommended_version);
    expect(column(current, /默认商店/).textContent).toContain(entry.default_store);
    for (const listing of entry.store_listings) {
      expect(current.textContent).toContain(listing.store);
      if (listing.listed_version !== null)
        expect(current.textContent).toContain(listing.listed_version);
    }
    expect(current.textContent).toMatch(/2026[-/]10[-/]22/);
    expect(current.textContent).toMatch(/(?:03|11):45/);
  }
  await settled(server);
  expect(server.requests('GET', LIST)).toHaveLength(1);
  expect(server.requests('GET', LIST)[0]!.query).toEqual({});
  expect(server.requests('POST', VERIFY)).toEqual([]);
  expect(server.requests('PUT')).toEqual([]);
  expect(server.requests('GET').every((r) => !r.headers.has('X-Step-Up-Token'))).toBe(true);
  expect(directFetch).not.toHaveBeenCalled();
});

it('[AC-F1-10h-LIST#3] h5 与 admin 无编辑入口，ios/android/harmony 均可编辑（超管也相同）', async () => {
  await mount(createServer(), { snapshot: { isSuper: true, permissions: [] } });
  await loaded();
  for (const entry of rows()) {
    const scope = within(row(entry.latest_version));
    const actions = [
      ...scope.queryAllByRole('button', { name: /编辑/ }),
      ...scope.queryAllByRole('link', { name: /编辑/ }),
    ];
    expect(actions).toHaveLength(entry.platform === 'h5' || entry.platform === 'admin' ? 0 : 1);
  }
});

it('[AC-F1-10h-LIST#4] 等待列表时可见加载状态，响应后才出现版本行', async () => {
  const server = createServer();
  const release = server.hold('GET', LIST);
  try {
    await mount(server);
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(1));
    expect(mainElement().textContent).toMatch(/加载/);
    expect(within(mainElement()).queryByText(item().latest_version, { exact: true })).toBeNull();
  } finally {
    release();
  }
  await loaded();
});

it('[AC-F1-10h-LIST#5] 空列表显示空态，不编造三端版本', async () => {
  const { server } = await mount(createServer([]));
  await waitFor(() => expect(mainElement().textContent).toMatch(/暂无|没有.*版本|无数据/));
  expect(server.requests('GET', LIST)).toHaveLength(1);
  expect(within(mainElement()).queryByText(item().latest_version)).toBeNull();
});

it('[AC-F1-10h-LIST#6] 网络失败可重试，再次读取成功后恢复列表', async () => {
  const server = createServer();
  server.once('GET', LIST, () => Promise.reject(new Error('offline')));
  await mount(server);
  await waitFor(() => expect(mainElement().textContent).toMatch(/失败|网络/));
  await click(button(mainElement(), /重试|重新加载/));
  await loaded();
  expect(server.requests('GET', LIST)).toHaveLength(2);
});

it('[AC-F1-10h-LIST#7] GET 10403 明确提示缺少权限，不误报空态或要求动态码', async () => {
  const server = createServer();
  server.once('GET', LIST, () =>
    failure(10403, { reason: 'admin_permission_denied' }, '没有操作权限'),
  );
  await mount(server);
  await waitFor(() => expect(mainElement().textContent).toMatch(/无权限|没有.*权限|权限不足/));
  expect(server.requests('POST')).toEqual([]);
  expect(screen.queryByRole('dialog', { name: /动态码/ })).toBeNull();
  expect(within(mainElement()).queryAllByRole('button', { name: /编辑/ })).toEqual([]);
});
