// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DETAIL,
  LIST,
  PARENT,
  UID,
  RISK_LABELS,
  createServer,
  detail,
  failure,
  ok,
} from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  backToList,
  button,
  click,
  detailLoaded,
  filterRisk,
  listQueries,
  loaded,
  mainElement,
  mount,
  nextPage,
  openDetail,
  settled,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function detailValue(label: string): Element {
  const labelNode = within(mainElement()).getByText(label, { exact: true });
  // antd Descriptions, horizontal or vertical (F1-07k: the finalized spec lays the basic
  // information out vertically): find the content cell paired with this label.
  const labelCell = labelNode.closest('.ant-descriptions-item-label');
  expect(labelCell, `label cell for ${label}`).not.toBeNull();
  let value: Element | null | undefined = labelCell!.nextElementSibling;
  if (!value?.matches('.ant-descriptions-item-content')) {
    // Vertical layout: the item holds label and content in one container, or the content sits
    // in the same column of the next row.
    value = labelCell!.parentElement?.querySelector('.ant-descriptions-item-content');
    if (!value) {
      const row = labelCell!.closest('tr');
      const index = row ? Array.from(row.children).indexOf(labelCell as HTMLElement) : -1;
      value = row?.nextElementSibling?.children.item(index) ?? null;
    }
  }
  expect(value, `value associated with ${label}`).toBeDefined();
  expect(value?.matches('.ant-descriptions-item-content')).toBe(true);
  return value!;
}

it(
  '[AC-F1-07i-DETAIL#1] 基础信息与联盟授权来自契约，时间为北京时间且不出现未接入功能',
  async () => {
    const { server } = await mount();
    await openDetail();
    await detailLoaded();
    for (const text of [
      UID,
      '测试用户1',
      '138****5678',
      'K7QX2M',
      PARENT,
      'L2',
      'appstore',
      '2026-10-13 01:05',
      '正常',
    ])
      expect(mainElement().textContent).toContain(text);
    expect(mainElement().textContent).toMatch(/sms|短信/);
    for (const label of ['基本信息', '邀请码', '注册方式', '注册渠道', '联盟授权'])
      expect(mainElement().textContent).toContain(label);
    const table = within(mainElement())
      .getByRole('columnheader', { name: '平台' })
      .closest('table');
    expect(table, '联盟授权表').not.toBeNull();
    expect(within(table!).getByRole('columnheader', { name: '状态' })).toBeDefined();
    expect(table!.textContent).toMatch(/淘宝|taobao/);
    expect(table!.textContent).toMatch(/active|有效|已授权|已绑定|正常/);
    expect(table!.textContent).toContain('2026-10-13 01:10');
    expect(within(table!).queryAllByRole('button')).toEqual([]);
    expect(mainElement().textContent).not.toMatch(
      /余额|流水|提现|订单|直推名单|风控命中|客服代办|加入黑名单|冻结账号|封禁账号|重置授权|停用返利|导出/,
    );
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
    expect(server.requests('POST')).toEqual([]);
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07i-DETAIL#2] 点击上级读取该 UID 的详情，空上级与空手机号展示破折号',
  async () => {
    const { server } = await mount();
    await openDetail();
    await detailLoaded();
    const parent = within(detailValue('上级') as HTMLElement).getByText(PARENT, { exact: true });
    expect(parent.closest('button, a')).not.toBeNull();
    await click(parent);
    await detailLoaded('P3RT8N');
    expect(server.requests('GET', `${LIST}/${PARENT}`)).toHaveLength(1);
    expect(mainElement().textContent).not.toContain('K7QX2M');
    for (const label of ['上级', '注册渠道'])
      expect(detailValue(label).textContent?.trim()).toBe('—');
    expect(detailValue('手机号').textContent).toContain('—');
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07i-DETAIL#3] 返回列表保留筛选和第二页，不短暂请求第一页',
  async () => {
    const { server } = await mount();
    await loaded();
    await filterRisk('正常');
    await settled(server);
    await nextPage();
    const size = Number(listQueries(server)[0]!['page_size']);
    const target = server.state.filter((row) => row.risk_state === 'normal')[size]!.user_id;
    await loaded(target);
    const before = listQueries(server).length;
    await openDetail(target);
    await detailLoaded('P3RT8N');
    await backToList();
    await loaded(target);
    await settled(server);
    expect(
      listQueries(server)
        .slice(before)
        .every(
          (query) =>
            query['page'] === '2' &&
            query['risk_state'] === 'normal' &&
            query['page_size'] === String(size),
        ),
    ).toBe(true);
    expect(listQueries(server).length - before).toBeLessThanOrEqual(1);
    expect(mainElement().textContent).toContain('正常');
    expect(within(mainElement()).queryByText(UID, { exact: true })).toBeNull();
  },
  FLOW_TIMEOUT,
);

it(
  '[AC-F1-07i-DETAIL#4] 详情失败可手动重试，重试只发一次详情请求',
  async () => {
    const server = createServer();
    server.once('GET', DETAIL, () => Promise.reject(new TypeError('offline')));
    await mount(server);
    await openDetail();
    await waitFor(() => expect(mainElement().textContent).toMatch(/失败|网络/));
    expect(server.requests('GET', DETAIL)).toHaveLength(1);
    await click(button(mainElement(), /重试|重新加载/));
    await detailLoaded();
    await settled(server);
    expect(server.requests('GET', DETAIL)).toHaveLength(2);
  },
  FLOW_TIMEOUT,
);

it('[AC-F1-07i-DETAIL#5] 详情加载与无权限态不显示旧基础信息', async () => {
  const server = createServer();
  const gate = Promise.withResolvers<Response>();
  server.once('GET', DETAIL, () => gate.promise);
  try {
    await mount(server);
    await openDetail();
    await waitFor(() => expect(server.requests('GET', DETAIL)).toHaveLength(1));
    expect(mainElement().textContent).toMatch(/加载/);
    expect(mainElement().textContent).not.toContain('K7QX2M');
  } finally {
    gate.resolve(failure(10403, { reason: 'admin_permission_denied' }));
  }
  await waitFor(() => expect(mainElement().textContent).toMatch(/无权限|没有.*权限|权限不足/));
  expect(mainElement().textContent).not.toContain('K7QX2M');
});

it('[AC-F1-07i-DETAIL#6] 没有联盟授权时显示空态，不补造平台授权行', async () => {
  const server = createServer();
  server.once('GET', DETAIL, () => ok({ ...detail(), union_bindings: [] }));
  await mount(server);
  await openDetail();
  await detailLoaded();
  expect(mainElement().textContent).toMatch(/暂无|无数据|没有.*授权/);
  expect(mainElement().textContent).not.toMatch(/已授权|已绑定/);
  expect(server.requests('POST')).toEqual([]);
});

it.each(['normal', 'frozen', 'banned'] as const)(
  '[AC-F1-07i-DETAIL#7] 详情 %s 的风控状态使用画板规定文案',
  async (state) => {
    const server = createServer();
    server.state[0]!.risk_state = state;
    await mount(server);
    await openDetail();
    await detailLoaded();
    expect(detailValue('风控状态').textContent?.trim()).toBe(RISK_LABELS[state]);
  },
  FLOW_TIMEOUT,
);
