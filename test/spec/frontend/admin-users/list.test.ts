// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LIST, PARENT, UID, RISK_LABELS, createServer, failure } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  button,
  click,
  filterRisk,
  listQueries,
  loaded,
  mainElement,
  mount,
  nextPage,
  row,
  settled,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it(
  '[AC-F1-07i-LIST#1] 首屏只请求一页，列与北京时间格式正确，空手机号用破折号',
  async () => {
    const { server, directFetch } = await mount();
    await loaded();
    await settled(server);
    const requests = listQueries(server);
    expect(requests).toHaveLength(1);
    expect(Object.keys(requests[0]!).sort()).toEqual(['page', 'page_size']);
    expect(requests[0]!['page']).toBe('1');
    const size = Number(requests[0]!['page_size']);
    expect(Number.isInteger(size) && size >= 2 && size <= 200).toBe(true);
    expect(
      within(mainElement())
        .getAllByRole('columnheader')
        .map((node) => node.textContent?.trim()),
    ).toEqual(['UID', '昵称', '手机号', '等级', '风控状态', '注册时间', '操作']);
    expect(
      within(row())
        .getAllByRole('cell')
        .map((node) => node.textContent?.trim()),
    ).toEqual([UID, '测试用户1', '138****5678', 'L2', '正常', '2026-10-13 01:05', '详情']);
    expect(within(row(PARENT)).getAllByRole('cell')[2]!.textContent).toBe('—');
    expect(row().querySelector('.ant-tag')?.textContent).toBe('正常');
    expect(row(PARENT).querySelector('.ant-tag')?.textContent).toBe('已冻结');
    const renderedIds = within(mainElement())
      .getAllByRole('row')
      .slice(1)
      .map((item) => within(item).getAllByRole('cell')[0]!.textContent?.trim());
    expect(renderedIds).toEqual(server.state.slice(0, size).map((item) => item.user_id));
    expect(server.log).toHaveLength(1);
    expect(directFetch).not.toHaveBeenCalled();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07i-LIST#2] 换页与第二页改筛选各请求一次，筛选重置页码且保持 page_size',
  async () => {
    const { server } = await mount();
    await loaded();
    const size = Number(listQueries(server)[0]!['page_size']);
    await nextPage();
    await loaded(server.state[size]!.user_id);
    await settled(server);
    expect(listQueries(server)).toEqual([
      { page: '1', page_size: String(size) },
      { page: '2', page_size: String(size) },
    ]);
    await filterRisk('已冻结');
    await loaded(PARENT);
    await settled(server);
    expect(listQueries(server)).toHaveLength(3);
    expect(listQueries(server)[2]).toEqual({
      page: '1',
      page_size: String(size),
      risk_state: 'frozen',
    });
    expect(within(mainElement()).queryByText(UID, { exact: true })).toBeNull();
  },
  FLOW_TIMEOUT,
);

it.each(Object.entries(RISK_LABELS))(
  '[AC-F1-07i-LIST#3] 风控筛选 %s 只发送契约枚举',
  async (state, label) => {
    const { server } = await mount();
    await loaded();
    await filterRisk(label);
    await waitFor(() => expect(listQueries(server)).toHaveLength(2));
    await settled(server);
    expect(listQueries(server)[1]).toEqual({
      page: '1',
      page_size: listQueries(server)[0]!['page_size'],
      risk_state: state,
    });
  },
  FLOW_TIMEOUT,
);

it('[AC-F1-07i-LIST#4] 未完成的列表请求显示加载态', async () => {
  const server = createServer();
  const release = server.hold('GET', LIST);
  try {
    await mount(server);
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(1));
    expect(mainElement().textContent).toMatch(/加载/);
    expect(within(mainElement()).queryAllByRole('button', { name: /^详情$/ })).toEqual([]);
  } finally {
    release();
  }
  await loaded();
});

it('[AC-F1-07i-LIST#5] 空列表显示空态，不编造用户', async () => {
  const { server } = await mount(createServer([]));
  await waitFor(() => expect(mainElement().textContent).toMatch(/暂无|没有.*用户|无数据/));
  expect(within(mainElement()).queryAllByRole('button', { name: /^详情$/ })).toEqual([]);
  expect(server.requests('GET', LIST)).toHaveLength(1);
});

it(
  '[AC-F1-07i-LIST#6] 网络错误显示错误态，手动重试仅新增一次请求',
  async () => {
    const server = createServer();
    server.once('GET', LIST, () => Promise.reject(new TypeError('offline')));
    await mount(server);
    await waitFor(() => expect(mainElement().textContent).toMatch(/失败|网络/));
    expect(server.requests('GET', LIST)).toHaveLength(1);
    await click(button(mainElement(), /重试|重新加载/));
    await loaded();
    await settled(server);
    expect(server.requests('GET', LIST)).toHaveLength(2);
  },
  FLOW_TIMEOUT,
);

it('[AC-F1-07i-LIST#7] 服务端 10403 显示无权限而不是空态', async () => {
  const server = createServer();
  server.once('GET', LIST, () => failure(10403, { reason: 'admin_permission_denied' }));
  await mount(server);
  await waitFor(() => expect(mainElement().textContent).toMatch(/无权限|没有.*权限|权限不足/));
  expect(within(mainElement()).queryAllByRole('button', { name: /^详情$/ })).toEqual([]);
  expect(screen.queryAllByRole('dialog')).toEqual([]);
  expect(server.requests('GET', LIST)).toHaveLength(1);
});

it('[AC-F1-07i-LIST#8] App 默认 users 路由无需 renderPage 注入即可加载用户页', async () => {
  const { server } = await mount(createServer(), undefined, true);
  await loaded();
  expect(server.requests('GET', LIST)).toHaveLength(1);
  expect(mainElement().textContent).not.toMatch(/页面建设中|待接入/);
});

it.each(['normal', 'frozen', 'banned'] as const)(
  '[AC-F1-07i-LIST#9] 列表 %s 的 Tag 使用画板规定文案',
  async (state) => {
    const server = createServer();
    server.state[0]!.risk_state = state;
    await mount(server);
    await loaded();
    expect(row().querySelector('.ant-tag')?.textContent).toBe(RISK_LABELS[state]);
  },
);
