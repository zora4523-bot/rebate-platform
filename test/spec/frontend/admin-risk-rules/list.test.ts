// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import {
  LIST,
  NAMES,
  TARGET,
  THRESHOLDS,
  VERIFY,
  createServer,
  failure,
  item,
  rows,
} from './fixtures.ts';
import {
  PERMITTED,
  SUPER,
  button,
  click,
  loaded,
  mainElement,
  mount,
  row,
  settled,
} from './helpers.ts';

// Mock the actual dictionary boundary, never the page's label formatter.
vi.mock('../../../../contracts/texts.admin.default.json', async () => {
  const { NAMES } = await import('./fixtures.ts');
  return {
    default: {
      texts: Object.fromEntries(
        Object.entries(NAMES).map(([code, name]) => [
          `admin_dict.${code === 'enabled' || code === 'disabled' ? 'risk_rule_status' : 'risk_action'}.${code}`,
          name,
        ]),
      ),
    },
  };
});

it('[AC-F1-10fa-LIST#1] 全部字段、开放 scene、全部动作与状态从注入字典读取，时间固定北京时间', async () => {
  const { server, directFetch } = await mount();
  await loaded('PASS_REGISTER');
  expect(within(mainElement()).queryByRole('tab', { name: '规则清单' })).not.toBeNull();
  for (const entry of rows()) {
    const current = row(entry.rule_id);
    for (const text of [
      entry.rule_id,
      entry.name,
      entry.scene,
      NAMES[entry.risk_action],
      NAMES[entry.status],
    ])
      expect(current.textContent).toContain(text);
    expect(current.textContent).toMatch(/2026[-/]10[-/]23/);
    expect(current.textContent).toContain('03:04');
  }
  expect(within(row('inv_08_self')).queryAllByRole('link')).toHaveLength(0);
  expect(within(row('inv_08_self')).queryAllByRole('button', { name: /阈值|配置/ })).toHaveLength(
    0,
  );
  await settled(server);
  expect(server.requests('GET', LIST)).toHaveLength(1);
  expect(server.requests('GET', LIST)[0]!.query).toEqual({});
  expect(server.requests('GET', LIST)[0]!.headers.has('X-Step-Up-Token')).toBe(false);
  expect(server.requests('POST')).toEqual([]);
  expect(screen.queryAllByRole('dialog')).toHaveLength(0);
  expect(directFetch).not.toHaveBeenCalled();
});

it('[AC-F1-10fa-LIST#2] 大于默认页长仍展示全表，不增加筛选或分页参数', async () => {
  const entries = Array.from({ length: 25 }, (_, index) =>
    item({
      rule_id: `RULE_${index}`,
      name: `规则 ${index}`,
      threshold_keys: [],
    }),
  );
  const { server } = await mount(createServer(entries));
  await loaded('RULE_24');
  for (const entry of entries) expect(row(entry.rule_id).textContent).toContain(entry.name);
  expect(within(mainElement()).queryAllByRole('combobox')).toHaveLength(0);
  expect(within(mainElement()).queryAllByRole('textbox')).toHaveLength(0);
  expect(server.requests('GET', LIST).map((request) => request.query)).toEqual([{}]);
});

it.each(THRESHOLDS)(
  '[AC-F1-10fa-LINK#1] %s 只进入配置中心对应配置项，本页没有阈值编辑或写请求',
  async (threshold) => {
    const { server } = await mount();
    await loaded();
    expect(within(mainElement()).queryAllByRole('spinbutton')).toHaveLength(0);
    expect(within(mainElement()).queryAllByRole('textbox')).toHaveLength(0);
    for (const name of THRESHOLDS) {
      const scope = within(row());
      expect(
        scope.queryByRole('link', { name }) ?? scope.queryByRole('button', { name }),
      ).not.toBeNull();
    }
    const scope = within(row());
    await click(
      scope.queryByRole('link', { name: threshold }) ??
        scope.getByRole('button', { name: threshold }),
    );
    await waitFor(() => expect(screen.queryByLabelText('配置中心导航')).not.toBeNull());
    const output = JSON.parse(screen.getByLabelText('配置中心导航').textContent!) as {
      pathname: string;
      search: string;
      state: unknown;
    };
    expect(output.pathname.replace(/\/$/, '')).toBe('/config');
    expect(decodeURIComponent(JSON.stringify(output))).toContain(threshold);
    expect(server.writes()).toEqual([]);
    expect(server.requests('POST', VERIFY)).toEqual([]);
  },
);

it('[AC-F1-10fa-STATES#1] 列表未返回显示加载态，返回后再展示行', async () => {
  const server = createServer();
  const release = server.hold('GET', LIST);
  try {
    await mount(server);
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(1));
    expect(mainElement().textContent).toMatch(/加载/);
    expect(within(mainElement()).queryByText(TARGET, { exact: true })).toBeNull();
    expect(server.writes()).toEqual([]);
  } finally {
    release();
  }
  await loaded();
});

it('[AC-F1-10fa-STATES#2] 空列表明确空态，不造规则和阈值入口', async () => {
  const { server } = await mount(createServer([]));
  await waitFor(() => expect(mainElement().textContent).toMatch(/暂无|没有.*规则|无数据/));
  expect(within(mainElement()).queryByText(TARGET, { exact: true })).toBeNull();
  expect(within(mainElement()).queryAllByRole('switch')).toHaveLength(0);
  expect(within(mainElement()).queryAllByRole('button', { name: /启用|停用/ })).toHaveLength(0);
  expect(server.requests('GET', LIST)).toHaveLength(1);
});

it('[AC-F1-10fa-STATES#3] 网络错误可重试，连续失败仍为错误态，成功后恢复完整列表', async () => {
  const server = createServer();
  server.once('GET', LIST, () => Promise.reject(new TypeError('offline')));
  server.once('GET', LIST, () => failure(50000));
  await mount(server);
  await waitFor(() => expect(mainElement().textContent).toMatch(/失败|网络/));
  await click(button(mainElement(), /重试|重新加载/));
  await settled(server);
  expect(server.requests('GET', LIST)).toHaveLength(2);
  expect(mainElement().textContent).toMatch(/失败|网络/);
  expect(within(mainElement()).queryByText(TARGET, { exact: true })).toBeNull();
  await click(button(mainElement(), /重试|重新加载/));
  await loaded();
  expect(server.requests('GET', LIST)).toHaveLength(3);
});

it('[AC-F1-10fa-PERMISSION#1] 10403 显示无权限，不作空列表或发起动态码', async () => {
  const server = createServer();
  server.once('GET', LIST, () => failure(10403, { reason: 'admin_permission_denied' }));
  await mount(server);
  await waitFor(() => expect(mainElement().textContent).toMatch(/无权限|没有.*权限|权限不足/));
  expect(within(mainElement()).queryByText(TARGET, { exact: true })).toBeNull();
  expect(server.requests('POST')).toEqual([]);
  expect(screen.queryAllByRole('dialog')).toHaveLength(0);
});

it.each(['risk.freeze', 'risk.ban', 'risk.blocklist', 'risk.appeal'])(
  '[AC-F1-10fa-PERMISSION#2] %s 可进风控但没有 config.risk 时不出现规则清单且不请求列表',
  async (permission) => {
    // Prove the page renders before checking absence, so an unimplemented page cannot pass.
    await mount(createServer(), PERMITTED);
    await loaded();
    expect(within(mainElement()).queryByRole('tab', { name: '规则清单' })).not.toBeNull();
    cleanup();
    const { server } = await mount(createServer(), { isSuper: false, permissions: [permission] });
    await settled(server);
    expect(within(mainElement()).queryByRole('tab', { name: '规则清单' })).toBeNull();
    expect(within(mainElement()).queryByText(TARGET, { exact: true })).toBeNull();
    expect(server.log).toEqual([]);
  },
);

it('[AC-F1-10fa-ROUTE#1] 默认 /risk 接入规则清单；risk.* 与 config.risk 同持者和超管可读', async () => {
  for (const snapshot of [PERMITTED, SUPER]) {
    await mount(createServer(), snapshot, true);
    await loaded();
    expect(within(mainElement()).queryByRole('tab', { name: '规则清单' })).not.toBeNull();
    expect(
      within(mainElement())
        .queryAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['规则清单']);
    cleanup();
  }
  // Check the negative on the real route too, after a positive so this case stays initially red.
  const { server } = await mount(
    createServer(),
    { isSuper: false, permissions: ['risk.freeze'] },
    true,
  );
  await settled(server);
  expect(within(mainElement()).queryByRole('tab', { name: '规则清单' })).toBeNull();
  expect(server.requests('GET', LIST)).toEqual([]);
  cleanup();
  const configOnly = await mount(
    createServer(),
    { isSuper: false, permissions: ['config.risk'] },
    true,
  );
  await settled(configOnly.server);
  expect(screen.queryByRole('link', { name: '风控' })).toBeNull();
  expect(configOnly.server.requests('GET', LIST)).toEqual([]);
});
