// @vitest-environment jsdom
import { cleanup, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DETAIL, LIST, PARENT, UID, createServer, detail, ok } from '../admin-users/fixtures.ts';
import {
  FLOW_TIMEOUT,
  card,
  click,
  detailHeader,
  detailLoaded,
  expectMonospace,
  mainElement,
  mount,
  openDetail,
  required,
  settled,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it.each([
  ['normal', '正常', 'ant-tag-success'],
  ['frozen', '已冻结', 'ant-tag-warning'],
  ['banned', '已封禁', 'ant-tag-error'],
] as const)(
  '[AC-F1-07j-DETAIL#1] 标题行展示 UID 与 %s 风控 Tag，保留返回入口',
  async (state, label, preset) => {
    const server = createServer();
    server.state[0]!.risk_state = state;
    await mount(server);
    await openDetail();
    await detailLoaded();
    const header = detailHeader();
    const uid = required(within(header).queryByText(UID, { exact: true }), 'UID in title row');
    expectMonospace(uid);
    expect(
      uid.closest('.ant-typography-secondary'),
      'UID uses secondary typography',
    ).not.toBeNull();
    const tag = required(within(header).queryByText(label, { exact: true }), 'risk in title row');
    expect(tag.closest('.ant-tag')?.classList.contains(preset)).toBe(true);
    expect(within(header).queryByRole('button', { name: '返回用户查询' })).not.toBeNull();
  },
  FLOW_TIMEOUT,
);

it('[AC-F1-07j-DETAIL#2] 基本信息为四列竖排 Descriptions，标签和契约值位于上下两行', async () => {
  await mount();
  await openDetail();
  await detailLoaded();
  const basic = card('基本信息');
  const descriptions = required(basic.querySelector('.ant-descriptions'), 'antd Descriptions');
  const firstRow = required(descriptions.querySelector('tr'), 'first labels row');
  expect(firstRow.querySelectorAll('th')).toHaveLength(4);
  for (const [label, value] of [
    ['UID', UID],
    ['昵称', '测试用户1'],
    ['手机号', '138****5678'],
    ['邀请码', 'K7QX2M'],
    ['上级', PARENT],
    ['等级', 'L2'],
    ['风控状态', '正常'],
    ['注册方式', '短信验证码'],
    ['注册渠道', 'appstore'],
    ['注册时间', '2026-10-13 01:05'],
  ] as const) {
    const labelNode = required(within(basic).queryByText(label, { exact: true }), `label ${label}`);
    const cell = required(labelNode.closest('th'), `vertical label cell ${label}`);
    const labelsRow = required(cell.parentElement, `label row ${label}`);
    const index = Array.from(labelsRow.children).indexOf(cell);
    const valuesRow = required(labelsRow.nextElementSibling, `content row ${label}`);
    const content = required(valuesRow.children.item(index), `content cell ${label}`);
    expect(content.tagName).toBe('TD');
    expect(content.textContent).toContain(value);
    expect(labelsRow.querySelector('.ant-descriptions-item-content')).toBeNull();
  }
});

it('[AC-F1-07j-DETAIL#3] 联盟授权表具名、状态含 Tag 和原始编码，时间列只读无行操作', async () => {
  const server = createServer();
  const user = detail();
  user.union_bindings.push({
    ...user.union_bindings[0]!,
    platform: 'jd',
    status: 'released',
    released_at: '2026-10-16T04:00:00Z',
    cooldown_until: '2026-11-15T04:00:00Z',
  });
  server.once('GET', DETAIL, () => ok(user));
  await mount(server);
  await openDetail();
  await detailLoaded();
  const table = required(
    within(card('联盟授权')).queryByRole('table', { name: '联盟授权' }),
    'accessible union table',
  );
  expect(table.getAttribute('aria-label')).toBe('联盟授权');
  for (const name of ['平台', '状态', '授权时间', '解除时间', '冷却到期'])
    expect(within(table).queryByRole('columnheader', { name })).not.toBeNull();
  expect(within(table).queryByRole('columnheader', { name: '操作' })).toBeNull();
  expect(within(table).queryAllByRole('button')).toEqual([]);
  expect(within(table).queryAllByRole('link')).toEqual([]);
  for (const [platform, label, code] of [
    ['淘宝', '已授权', 'active'],
    ['京东', '已解除', 'released'],
  ] as const) {
    const platformNode = required(within(table).queryByText(platform, { exact: true }), platform);
    const row = required(platformNode.closest('tr'), `${platform} row`);
    const tag = required(within(row).queryByText(label, { exact: true }), 'status label');
    expect(tag.closest('.ant-tag')).not.toBeNull();
    const raw = required(within(row).queryByText(code, { exact: true }), 'raw status code');
    expect(raw.closest('.ant-typography-secondary')).not.toBeNull();
    expect(raw.closest('td')).toBe(tag.closest('td'));
  }
  expect(table.textContent).toContain('2026-10-13 01:10');
  expect(table.textContent).toContain('2026-10-16 12:00');
  expect(table.textContent).toContain('2026-11-15 12:00');
  expect(server.requests('POST')).toEqual([]);
});

it(
  '[AC-F1-07j-DETAIL#4] 等宽上级入口可点击，切换详情后标题 UID 和风控 Tag 同步更新',
  async () => {
    const { server } = await mount();
    await openDetail();
    await detailLoaded();
    const parent = required(
      within(card('基本信息')).queryByText(PARENT, { exact: true }),
      'parent UID',
    );
    const action = required(parent.closest<HTMLElement>('a, button'), 'clickable parent');
    expectMonospace(parent);
    await click(action);
    await detailLoaded('P3RT8N');
    await settled(server);
    expect(server.requests('GET', `${LIST}/${PARENT}`)).toHaveLength(1);
    const header = detailHeader();
    expect(within(header).queryByText(PARENT, { exact: true })).not.toBeNull();
    expect(within(header).queryByText(UID, { exact: true })).toBeNull();
    const risk = required(within(header).queryByText('已冻结', { exact: true }), 'parent risk');
    expect(risk.closest('.ant-tag-warning')).not.toBeNull();
    expect(mainElement().textContent).not.toContain('K7QX2M');
  },
  FLOW_TIMEOUT,
);
