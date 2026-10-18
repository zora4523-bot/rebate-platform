// @vitest-environment jsdom
import { cleanup, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PARENT, UID } from '../admin-users/fixtures.ts';
import {
  FLOW_TIMEOUT,
  appliedBar,
  card,
  expectMonospace,
  filterRisk,
  listQueries,
  loaded,
  mainElement,
  mount,
  required,
  row,
  searchBox,
  settled,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('[AC-F1-07j-LIST#1] 筛选卡的 UID 或手机号、风控状态标签关联控件并在上方', async () => {
  await mount();
  await loaded();
  expect(within(mainElement()).queryByRole('heading', { name: '用户查询' })).not.toBeNull();
  const input = searchBox();
  const risk = required(
    within(mainElement()).queryByRole('combobox', { name: /风控状态/ }),
    'risk filter',
  );
  const filterCard = required(input.closest('.ant-card'), 'filter Card');
  expect(filterCard.contains(risk)).toBe(true);
  for (const [text, control] of [
    ['UID 或手机号', input],
    ['风控状态', risk],
  ] as const) {
    const label = required(
      Array.from(filterCard.querySelectorAll('label')).find((node) => node.textContent === text),
      `visible label ${text}`,
    );
    const labelledBy = control.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
    expect(
      (control.id !== '' && label.htmlFor === control.id) ||
        (label.id !== '' && labelledBy.includes(label.id)) ||
        label.contains(control),
      `label association ${text}`,
    ).toBe(true);
    const item = required(label.closest('.ant-form-item'), `Form.Item ${text}`);
    expect(item.contains(control)).toBe(true);
    expect(
      item.closest('.ant-form-vertical'),
      'Form vertical puts labels above controls',
    ).not.toBeNull();
    expect(label.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  }
  expect(within(filterCard as HTMLElement).queryByRole('button', { name: '查找' })).not.toBeNull();
});

it(
  '[AC-F1-07j-LIST#2] 未筛选无已应用条，筛选后在卡下方播报条件和服务端总数，清除后消失',
  async () => {
    const { server } = await mount();
    await loaded();
    expect(within(mainElement()).queryByText('已应用', { exact: true })).toBeNull();
    // More than one page: the summary must use total, not items.length.
    await filterRisk('正常');
    await settled(server);
    const bar = appliedBar();
    const total = server.state.filter((item) => item.risk_state === 'normal').length;
    expect(total).toBeGreaterThan(Number(listQueries(server)[0]!['page_size']));
    expect(bar.textContent).toMatch(/风控状态[：:\s]*正常/);
    expect(bar.textContent).toContain(`共 ${total} 条`);
    const filterCard = required(searchBox().closest('.ant-card'), 'filter card');
    expect(filterCard.contains(bar)).toBe(false);
    expect(filterCard.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await filterRisk('已冻结');
    await loaded(PARENT);
    await settled(server);
    expect(appliedBar().textContent).toMatch(/风控状态[：:\s]*已冻结/);
    expect(appliedBar().textContent).toContain('共 1 条');
    expect(appliedBar().textContent).not.toContain('正常');
    await filterRisk('全部');
    await loaded();
    await settled(server);
    expect(within(mainElement()).queryByText('已应用', { exact: true })).toBeNull();
  },
  FLOW_TIMEOUT,
);

it('[AC-F1-07j-LIST#3] 列表卡标题、横向滚动与等宽 UID；每行详情读屏名包含本行 UID', async () => {
  const { server } = await mount();
  await loaded();
  const tableCard = card('用户查询列表');
  const table = required(within(tableCard).queryByRole('table'), 'users table');
  const ancestors: HTMLElement[] = [];
  let parent = table.parentElement;
  while (parent && parent !== tableCard) {
    ancestors.push(parent);
    parent = parent.parentElement;
  }
  expect(ancestors.some((node) => /^(auto|scroll)$/.test(getComputedStyle(node).overflowX))).toBe(
    true,
  );
  const size = Number(listQueries(server)[0]!['page_size']);
  for (const item of server.state.slice(0, size)) {
    const itemRow = row(item.user_id);
    const action = required(
      within(itemRow).queryByRole('button', { name: `详情 ${item.user_id}` }),
      `accessible action for ${item.user_id}`,
    );
    expect(action.textContent?.trim()).toBe('详情');
    expectMonospace(required(within(itemRow).queryByText(item.user_id, { exact: true }), 'UID'));
  }
  expect(tableCard.contains(row(UID))).toBe(true);
});
