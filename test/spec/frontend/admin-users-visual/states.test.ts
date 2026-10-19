// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LIST, createServer } from '../admin-users/fixtures.ts';
import {
  FLOW_TIMEOUT,
  appliedBar,
  button,
  card,
  click,
  filterRisk,
  listQueries,
  loaded,
  mainElement,
  mount,
  required,
  searchBox,
  settled,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it(
  '[AC-F1-07j-STATES#1] 无匹配结果展示图标和当前条件；重置只请求一次且清除 risk_state',
  async () => {
    const { server } = await mount();
    await loaded();
    await filterRisk('已封禁');
    await settled(server);
    const list = card('用户查询列表');
    const empty = required(list.querySelector('.ant-empty'), 'antd Empty');
    expect(empty.textContent).toContain('没有符合条件的用户');
    expect(empty.querySelector('svg, img'), 'empty illustration').not.toBeNull();
    expect(empty.textContent).toMatch(/当前条件[：:]/);
    expect(empty.textContent).toMatch(/风控状态[：:\s]*已封禁/);
    expect(appliedBar().textContent).toContain('共 0 条');
    const before = listQueries(server).length;
    const oldQuery = listQueries(server).at(-1)!;
    await click(button(list, '重置条件'));
    await loaded();
    await settled(server);
    expect(listQueries(server).slice(before)).toEqual([
      { page: '1', page_size: oldQuery['page_size'] },
    ]);
    expect(within(mainElement()).queryByText('已应用', { exact: true })).toBeNull();
    expect(within(mainElement()).queryByText('没有符合条件的用户', { exact: true })).toBeNull();
    const risk = required(
      within(mainElement()).queryByRole('combobox', { name: /风控状态/ }),
      'risk',
    );
    expect(risk.closest('.ant-select')?.textContent).toContain('全部');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07j-STATES#2] Result 出错态保留已填条件；重试只请求一次且参数完全相同',
  async () => {
    const { server } = await mount();
    await loaded();
    const input = searchBox();
    await act(async () => {
      fireEvent.change(input, { target: { value: '13800005678' } });
    });
    server.once('GET', LIST, () => Promise.reject(new Error('synthetic offline')));
    await filterRisk('已冻结');
    await settled(server);
    const result = required(mainElement().querySelector<HTMLElement>('.ant-result'), 'antd Result');
    expect(result.textContent).toContain('列表加载失败');
    expect(result.textContent).toContain(
      '网络错误或服务异常；已填条件保留，点【重试】按同样条件重新请求。',
    );
    expect(result.querySelector('.ant-result-icon svg'), 'warning illustration').not.toBeNull();
    expect(searchBox().value).toBe('13800005678');
    const query = listQueries(server).at(-1)!;
    expect(query['risk_state']).toBe('frozen');
    const before = listQueries(server).length;
    await click(button(result, '重试'));
    await settled(server);
    await waitFor(() => expect(mainElement().querySelector('.ant-result')).toBeNull());
    expect(listQueries(server).slice(before)).toEqual([query]);
    expect(searchBox().value).toBe('13800005678');
    expect(appliedBar().textContent).toMatch(/风控状态[：:\s]*已冻结/);
  },
  FLOW_TIMEOUT,
);

it('[AC-F1-07j-STATES#3] 首次请求在途时列表卡有可感知的加载中提示', async () => {
  const server = createServer();
  const release = server.hold('GET', LIST);
  try {
    await mount(server);
    await waitFor(() => expect(listQueries(server)).toHaveLength(1));
    const list = card('用户查询列表');
    const status = Array.from(list.querySelectorAll('[role="status"], [aria-live="polite"]')).find(
      (node) => /加载/.test(node.textContent ?? ''),
    );
    expect(required(status, 'perceivable loading message').textContent).toMatch(/加载/);
    expect(within(list).queryByText('没有符合条件的用户', { exact: true })).toBeNull();
    expect(within(list).queryByRole('button', { name: '重试' })).toBeNull();
  } finally {
    await act(async () => release());
    await settled(server);
  }
});

it('[AC-F1-07j-STATES#4] 更换筛选后请求在途仍有可感知提示，不能只留下旧表格', async () => {
  const { server } = await mount();
  await loaded();
  const release = server.hold('GET', LIST);
  try {
    await filterRisk('已冻结');
    await waitFor(() => expect(listQueries(server)).toHaveLength(2));
    const list = card('用户查询列表');
    const status = Array.from(list.querySelectorAll('[role="status"], [aria-live="polite"]')).find(
      (node) => /加载/.test(node.textContent ?? ''),
    );
    expect(required(status, 'perceivable refresh message').textContent).toMatch(/加载/);
  } finally {
    await act(async () => release());
    await settled(server);
  }
});
