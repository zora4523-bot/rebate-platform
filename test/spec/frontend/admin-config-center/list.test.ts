// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GROUPS, LIST, TARGET, createServer, failure, item } from './fixtures.ts';
import {
  button,
  click,
  column,
  editButton,
  enabled,
  expectText,
  loaded,
  mainElement,
  mount,
  navigation,
  reveal,
  row,
  settled,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('[AC-F1-06zg-LIST#1] 六组导航、登记顺序、键与说明、当前值、类型、范围、版本和最近修改', async () => {
  const { server, directFetch } = await mount();
  await loaded();
  for (const name of GROUPS)
    expect(
      navigation().some((node) => node.textContent?.includes(name)),
      name,
    ).toBe(true);
  const first = row('withdraw.monthly_count_per_user');
  expect(first.compareDocumentPosition(row()) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expectText(row(), '每日', '提现');
  expect(column(TARGET, /当前值/).textContent).toMatch(/3/);
  expect(column(TARGET, /类型/).textContent).toMatch(/数字|数值|number/);
  expect(column(TARGET, /适用范围|生效范围/).textContent?.trim()).toBeTruthy();
  expect(column(TARGET, /版本/).textContent).toMatch(/3/);
  expectText(column(TARGET, /最近修改/), 'ops-yi');
  expect(column(TARGET, /最近修改/).textContent).toMatch(/2026[-/]10[-/]0?9/);
  expectText(row('withdraw.payee_daily_count'), '系统初始化');
  // No numeric default field exists in AdminConfigItem: never treat null as zero or guess a limit.
  expect(column('withdraw.payee_daily_count', /当前值/).textContent).toMatch(
    /内置默认|默认值|使用默认/,
  );
  expect(enabled(editButton())).toBe(true);
  await settled(server);
  expect(server.requests('GET', LIST)).toHaveLength(1);
  expect(server.requests('GET')[0]!.headers.has('X-Step-Up-Token')).toBe(false);
  expect(server.requests('POST')).toEqual([]);
  expect(directFetch).not.toHaveBeenCalled();
});

it('[AC-F1-06zg-LIST#2] 只读 routes 与 external_hosts 显示原因，超管也不能编辑', async () => {
  const { server } = await mount();
  for (const key of ['agent.page_guide.routes', 'external_hosts']) {
    await reveal(key, server);
    expect(row(key).textContent).toMatch(/只读|暂不支持|不可.*编辑/);
    expect(
      within(row(key))
        .queryAllByRole('button', { name: /编辑/ })
        .every((node) => !enabled(node)),
    ).toBe(true);
    for (const node of within(row(key)).queryAllByRole('button', { name: /编辑/ }))
      await click(node);
  }
  await settled(server);
  expect(server.requests('PUT')).toEqual([]);
  expect(server.requests('POST')).toEqual([]);
});

it('[AC-F1-06zg-LIST#3] 加载中的列表有状态提示且不能编辑', async () => {
  const server = createServer();
  const release = server.hold('GET', LIST);
  try {
    await mount(server);
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(1));
    await waitFor(() => {
      const main = mainElement();
      expect(
        /加载/.test(main.textContent ?? '') ||
          main.matches('[aria-busy="true"]') ||
          main.querySelector('[aria-busy="true"], .ant-spin-spinning') !== null,
      ).toBe(true);
    });
    expect(
      within(mainElement())
        .queryAllByRole('button', { name: /编辑/ })
        .every((node) => !enabled(node)),
    ).toBe(true);
  } finally {
    release();
  }
  await loaded();
});

it('[AC-F1-06zg-LIST#4] 空响应显示空态，不补造固定配置', async () => {
  const { server } = await mount(createServer([]));
  await waitFor(() => expect(mainElement().textContent).toMatch(/暂无|无数据|没有.*配置/));
  expect(within(mainElement()).queryAllByRole('button', { name: /编辑/ })).toEqual([]);
  expect(server.requests('GET', LIST)).toHaveLength(1);
});

it('[AC-F1-06zg-LIST#5] 出错后显式重试只多发一次列表 GET', async () => {
  const server = createServer();
  server.once('GET', LIST, () => Promise.reject(new Error('offline')));
  await mount(server);
  await waitFor(() => expect(mainElement().textContent).toMatch(/失败|网络/));
  expect(server.requests('GET', LIST)).toHaveLength(1);
  await click(button(mainElement(), /重试|重新加载/));
  await loaded();
  await settled(server);
  expect(server.requests('GET', LIST)).toHaveLength(2);
});

it('[AC-F1-06zg-LIST#6] 列表 10403 是无权限状态，不是空态，也不发起二次验证', async () => {
  const server = createServer();
  server.once('GET', LIST, () => failure(10403, { reason: 'admin_permission_denied' }));
  await mount(server);
  await waitFor(() => expect(mainElement().textContent).toMatch(/无权限|没有.*权限|权限不足/));
  expect(screen.queryAllByRole('dialog')).toEqual([]);
  expect(server.requests('POST')).toEqual([]);
  expect(within(mainElement()).queryAllByRole('button', { name: /编辑/ })).toEqual([]);
});

it('[AC-F1-06zg-LIST#7] 201 项按契约页码分页，后续登记键仍能看到', async () => {
  const data = Array.from({ length: 201 }, (_, index) => item(`withdraw.fixture_${index}`));
  const server = createServer(data);
  await mount(server);
  await loaded(data[0]!.key);
  for (
    let attempt = 0;
    attempt < 201 && !within(mainElement()).queryByText(data[200]!.key, { exact: true });
    attempt += 1
  ) {
    await settled(server);
    const next = mainElement().querySelector<HTMLElement>(
      '[title="Next Page"], [title="下一页"], [aria-label="Next Page"], [aria-label="下一页"]',
    );
    if (next === null) break;
    await click(next);
    await settled(server);
  }
  await loaded(data[200]!.key);
  const requests = server.requests('GET', LIST);
  expect(requests.length).toBeGreaterThan(1);
  expect(requests.map((request) => Number(request.query['page'] ?? 1))).toEqual(
    Array.from({ length: requests.length }, (_, index) => index + 1),
  );
  for (const request of requests) {
    expect(Number(request.query['page_size'] ?? 20)).toBeLessThanOrEqual(200);
    expect(Object.keys(request.query).every((key) => ['page', 'page_size'].includes(key))).toBe(
      true,
    );
  }
}, 40_000);

it('[AC-F1-06zg-LIST#8] App 默认 config 菜单接配置中心，无 renderPage 注入', async () => {
  const { server } = await mount(createServer(), undefined, true);
  await loaded();
  expect(server.requests('GET', LIST)).toHaveLength(1);
  expect(mainElement().textContent).not.toMatch(/页面建设中|待接入/);
});

it('[AC-F1-06zg-LIST#9] 切换分组只显示该组行，返回提现组保留服务端登记顺序', async () => {
  const { server } = await mount();
  await loaded();
  const risk = navigation().find((node) => node.textContent?.includes('风控阈值'));
  expect(risk).toBeDefined();
  await click(risk!);
  await loaded('risk.fixture_threshold');
  expect(within(mainElement()).queryByText(TARGET, { exact: true })).toBeNull();
  const withdraw = navigation().find((node) => node.textContent?.includes('提现设置'));
  expect(withdraw).toBeDefined();
  await click(withdraw!);
  await loaded();
  expect(within(mainElement()).queryByText('risk.fixture_threshold', { exact: true })).toBeNull();
  expect(
    row('withdraw.monthly_count_per_user').compareDocumentPosition(row()) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  await settled(server);
  expect(server.requests('POST')).toEqual([]);
});
