// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GROUPS, LIST, TARGET, createServer, failure, item, rows } from './fixtures.ts';
import {
  button,
  checked,
  click,
  control,
  expectText,
  loaded,
  mainElement,
  mount,
  row,
  settled,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function column(key: string, title: string | RegExp): HTMLElement {
  const current = row(key);
  const table = current.closest('table, [role="table"]');
  expect(table, 'semantic columns for current/default/permission').not.toBeNull();
  const headings = within(table as HTMLElement).getAllByRole('columnheader');
  const index = headings.findIndex((heading) => {
    const text = heading.textContent?.trim() ?? '';
    return typeof title === 'string' ? text === title : title.test(text);
  });
  expect(index, String(title)).toBeGreaterThanOrEqual(0);
  const cells = Array.from(current.querySelectorAll<HTMLElement>('td, [role="cell"]'));
  expect(cells[index]).toBeDefined();
  return cells[index]!;
}

it('[AC-F1-06zf-LIST#1] 按四组呈现完整登记列表、服务端组内顺序、列与默认差异，仅 GET 一次', async () => {
  const { server, directFetch } = await mount();
  await loaded('credit.enabled.taobao');
  const headings = GROUPS.map((name) => within(mainElement()).getByRole('heading', { name }));
  const groupKeys = [rows().slice(0, 4), rows().slice(4, 8), rows().slice(8, 14), rows().slice(14)];
  for (const [index, entries] of groupKeys.entries()) {
    let previous: Element = headings[index]!;
    for (const entry of entries) {
      const current = row(entry.key);
      expect(previous.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
        0,
      );
      if (headings[index + 1])
        expect(
          current.compareDocumentPosition(headings[index + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).not.toBe(0);
      previous = current;
      for (const permission of entry.permissions)
        expectText(column(entry.key, '权限点'), permission);
    }
  }
  expectText(row(TARGET), '淘宝转链');
  for (const entry of rows().filter((value) => value.value_type === 'boolean')) {
    checked(entry.key, (entry.value ?? entry.default) as boolean);
    // Labels describe the business meaning: e.g. 正常 / 已暂停 / 仅内部测试名单.
    expect(column(entry.key, '当前状态').textContent?.trim()).toBeTruthy();
    const defaultCell = column(entry.key, '默认');
    expect(defaultCell.textContent?.replace('与默认不同', '').trim()).toBeTruthy();
    expect(defaultCell.textContent?.includes('与默认不同')).toBe(
      (entry.value ?? entry.default) !== entry.default,
    );
  }
  expectText(column(TARGET, '当前状态'), '已开放');
  expectText(column(TARGET, '默认'), '未开放');
  const updated = column(TARGET, '最近修改');
  expectText(updated, 'ops-yi');
  expect(updated.textContent).toMatch(/2026[-/]10[-/]0?9/);
  // Accept the API's UTC time or its +08:00 display, without depending on the host timezone.
  expect(updated.textContent).toMatch(/(?:02|10):00/);
  for (const entry of rows().filter((value) => value.value === null))
    expectText(column(entry.key, '最近修改'), '系统初始化');
  expect(column(TARGET, /^(?:暂停或开启后的)?影响$/).textContent).toMatch(
    /已生成.*链接.*订单.*不受影响/,
  );
  expectText(row('convert.off_reason.pdd'), 'not_launched');
  expectText(row('agent.model_route'), 'demo_primary', 'demo_fallback');
  await settled(server);
  expect(server.requests('GET', LIST)).toHaveLength(1);
  expect(
    Object.keys(server.requests('GET', LIST)[0]!.query).every((key) =>
      ['page', 'page_size'].includes(key),
    ),
  ).toBe(true);
  expect(server.requests('POST')).toEqual([]);
  expect(server.requests('GET')[0]!.headers.has('X-Step-Up-Token')).toBe(false);
  expect(directFetch).not.toHaveBeenCalled();
});

it('[AC-F1-06zf-LIST#2] 从未写入时 true/false 默认分别生效，明确 false 不被 true 默认覆盖', async () => {
  await mount();
  await loaded('credit.enabled.taobao');
  checked('parse.tpwd.enabled', true);
  checked('credit.enabled.taobao', false);
  checked('claims.enabled', false);
  expect(column('parse.tpwd.enabled', '默认').textContent).not.toContain('与默认不同');
  expect(column('credit.enabled.taobao', '默认').textContent).not.toContain('与默认不同');
  expect(column('claims.enabled', '默认').textContent).toContain('与默认不同');
});

it('[AC-F1-06zf-LIST#3] 服务端只读 boolean/object 均不可改且有说明，即使账号为超管', async () => {
  const { server } = await mount();
  await loaded();
  expect(control('agent.whitelist_only').disabled).toBe(true);
  for (const key of ['agent.whitelist_only', 'agent.model_route']) {
    expect(row(key).textContent).toMatch(/只读|不可.*修改|不.*支持.*修改/);
    for (const element of within(row(key)).queryAllByRole('switch'))
      expect((element as HTMLButtonElement).disabled).toBe(true);
    expect(
      within(row(key))
        .queryAllByRole('button')
        .every(
          (element) =>
            (element as HTMLButtonElement).disabled ||
            element.getAttribute('aria-disabled') === 'true',
        ),
    ).toBe(true);
  }
  await click(control('agent.whitelist_only'));
  await settled(server);
  expect(server.requests('PUT')).toEqual([]);
});

it('[AC-F1-06zf-LIST#4] 加载请求未完成时显示加载状态，无可操作开关', async () => {
  const server = createServer();
  const release = server.hold('GET', LIST);
  try {
    await mount(server);
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(1));
    expect(mainElement().textContent).toMatch(/加载/);
    expect(
      within(mainElement())
        .queryAllByRole('switch')
        .every((element) => (element as HTMLButtonElement).disabled),
    ).toBe(true);
  } finally {
    release();
  }
  await loaded();
});

it('[AC-F1-06zf-LIST#5] 空列表有空态且不补造固定开关', async () => {
  const { server } = await mount(createServer([]));
  await waitFor(() => expect(mainElement().textContent).toMatch(/暂无|没有.*开关|无数据/));
  expect(within(mainElement()).queryAllByRole('switch')).toEqual([]);
  expect(server.requests('GET', LIST)).toHaveLength(1);
});

it('[AC-F1-06zf-LIST#6] 首次网络失败有错误态，点击重试仅新增一次 GET', async () => {
  const server = createServer();
  server.once('GET', LIST, () => Promise.reject(new TypeError('offline')));
  await mount(server);
  await waitFor(() => expect(mainElement().textContent).toMatch(/失败|网络/));
  expect(server.requests('GET', LIST)).toHaveLength(1);
  await click(button(mainElement(), /重试|重新加载/));
  await loaded();
  await settled(server);
  expect(server.requests('GET', LIST)).toHaveLength(2);
});

it('[AC-F1-06zf-LIST#7] GET 10403 显示无权限，不能误报空列表或进入二次验证', async () => {
  const server = createServer();
  server.once('GET', LIST, () =>
    failure(10403, { reason: 'admin_permission_denied' }, '没有操作权限'),
  );
  await mount(server);
  await waitFor(() => expect(mainElement().textContent).toMatch(/无权限|没有.*权限|权限不足/));
  expect(within(mainElement()).queryAllByRole('switch')).toEqual([]);
  expect(screen.queryAllByRole('dialog')).toEqual([]);
  expect(server.requests('GET', LIST)).toHaveLength(1);
});

it('[AC-F1-06zf-LIST#8] 超过单页容量时按 page/page_size 翻页或续读，后续登记项不丢失', async () => {
  // 201 concrete registered-pattern keys force at least two pages even at the contract max 200.
  const data = Array.from({ length: 201 }, (_, index) =>
    item(`agent.tools.probe_${index}.enabled`),
  );
  const server = createServer(data);
  await mount(server);
  await loaded(data[0]!.key);
  // Both user pagination and automatic page collection are valid. Never force a fetch-all API.
  for (
    let attempt = 0;
    attempt < 201 && within(mainElement()).queryByText(data[200]!.key, { exact: true }) === null;
    attempt += 1
  ) {
    await settled(server);
    const next = mainElement().querySelector<HTMLElement>(
      '[title="Next Page"], [title="下一页"], [aria-label="Next Page"], [aria-label="下一页"]',
    );
    if (next === null) break;
    const before = server.requests('GET', LIST).length;
    await click(next);
    await waitFor(() => expect(server.requests('GET', LIST).length).toBeGreaterThan(before));
  }
  await loaded(data[200]!.key);
  const requests = server.requests('GET', LIST);
  expect(requests.length).toBeGreaterThan(1);
  expect(requests.map((request) => Number(request.query['page'] ?? 1))).toEqual(
    Array.from({ length: requests.length }, (_, index) => index + 1),
  );
  expect(new Set(requests.map((request) => JSON.stringify(request.query))).size).toBe(
    requests.length,
  );
  for (const request of requests) {
    expect(Object.keys(request.query).every((key) => ['page', 'page_size'].includes(key))).toBe(
      true,
    );
    expect(Number(request.query['page_size'] ?? 20)).toBeLessThanOrEqual(200);
  }
}, 40_000);

it('[AC-F1-06zf-LIST#9] App 默认 switches 路由接本页，无 renderPage 注入仍加载列表', async () => {
  const { server } = await mount(createServer(), undefined, true);
  await loaded();
  expect(server.requests('GET', LIST)).toHaveLength(1);
  expect(mainElement().textContent).not.toMatch(/页面建设中|待接入/);
});
