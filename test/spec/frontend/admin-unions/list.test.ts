// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ADMIN_ID, LIST, PHONES, createServer, failure, rows } from './fixtures.ts';
import { button, click, loaded, main, mount, row } from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const dictionaries = import.meta.glob<{ texts: Record<string, string> }>(
  '../../../../contracts/texts.admin.default.json',
  { eager: true, import: 'default' },
);
const dictionary = Object.values(dictionaries)[0]?.texts ?? {};

it('[AC-F1-10ga-LIST#1] 全量只读列表：北京时间、估算、更新人与探测结果；状态只用字典或编码', async () => {
  const fixture = createServer(rows().map((r) => ({ ...r, alert_phones_configured: false })));
  fixture.phones.items = [];
  const { server, directFetch } = await mount(fixture);
  await loaded();
  for (const account of rows()) {
    const current = row(account.account_name);
    expect(current.textContent).toMatch(
      new RegExp(
        account.platform === 'taobao'
          ? 'taobao|淘宝'
          : account.platform === 'jd'
            ? 'jd|京东'
            : 'pdd|拼多多',
        'i',
      ),
    );
    const label = dictionary[`admin_dict.union_accounts.auth_status.${account.auth_status}`];
    expect(
      current.textContent?.includes(account.auth_status) ||
        (label !== undefined && current.textContent?.includes(label)),
    ).toBe(true);
    expect(current.textContent?.includes('估算')).toBe(account.auth_expires_estimated);
  }
  const oauth = row('测试 OAuth 账号');
  expect(oauth.textContent).toMatch(/2026[-/]12[-/]31/);
  expect(oauth.textContent).toContain('00:30');
  expect(oauth.textContent).toMatch(/2026[-/]10[-/]21/);
  expect(oauth.textContent).toContain('00:20');
  expect(oauth.textContent).toContain(ADMIN_ID);
  expect(oauth.textContent).toMatch(/2026[-/]10[-/]23/);
  expect(oauth.textContent).toContain('01:10');
  expect(oauth.textContent).toMatch(/成功|正常|通过/);
  expect(row('测试手工账号').textContent).toMatch(/失败|异常/);
  expect(row('测试手工账号').textContent).toContain('fixture_probe_rejected');
  expect(row('测试免授权账号').textContent).not.toContain(ADMIN_ID);
  expect(row('测试免授权账号').textContent).not.toMatch(/Invalid Date|1970|2026[-/]12[-/]31/);
  expect(main().textContent).toContain('未配置告警手机号');
  expect(server.requests('GET', LIST)).toHaveLength(1);
  expect(server.requests('GET', LIST)[0]!.query).toEqual({});
  expect(server.requests('POST')).toEqual([]);
  for (const request of server.requests('GET'))
    expect(request.headers.has('X-Step-Up-Token')).toBe(false);
  expect(directFetch).not.toHaveBeenCalled();
});

it('[AC-F1-10ga-LIST#2] 按 reauth_mode 决定入口，账号和推广位页签可访问', async () => {
  await mount();
  await loaded();
  expect(within(main()).getByRole('tab', { name: '联盟账号' })).toBeDefined();
  expect(within(main()).getByRole('tab', { name: '推广位' })).toBeDefined();
  expect(button(row('测试 OAuth 账号'), '重新授权')).toBeDefined();
  expect(within(row('测试 OAuth 账号')).queryByRole('button', { name: '录入新凭据' })).toBeNull();
  expect(button(row('测试手工账号'), '录入新凭据')).toBeDefined();
  expect(within(row('测试手工账号')).queryByRole('button', { name: '重新授权' })).toBeNull();
  expect(
    within(row('测试免授权账号')).queryAllByRole('button', { name: /授权|凭据|更新/ }),
  ).toEqual([]);
});

it('[AC-F1-10ga-LIST#3] 已配置告警手机时不显示缺配警告', async () => {
  await mount(createServer(rows().map((r) => ({ ...r, alert_phones_configured: true }))));
  await loaded();
  expect(main().textContent).not.toContain('未配置告警手机号');
});

it('[AC-F1-10ga-LIST#4] 加载与空态分开，空列表不补造账号', async () => {
  const server = createServer([]);
  const release = server.hold('GET', LIST);
  try {
    await mount(server);
    await waitFor(() => expect(server.requests('GET', LIST)).toHaveLength(1));
    expect(main().textContent).toMatch(/加载/);
    expect(main().textContent).not.toMatch(/暂无.*账号|没有.*账号/);
  } finally {
    release();
  }
  await waitFor(() => expect(main().textContent).toMatch(/暂无|没有.*账号|无数据/));
  expect(main().textContent).not.toContain('测试 OAuth 账号');
  expect(within(main()).queryAllByRole('button', { name: /重新授权|录入新凭据/ })).toEqual([]);
});

it('[AC-F1-10ga-LIST#5] 网络失败可重试，重试读取成功', async () => {
  const server = createServer();
  server.once('GET', LIST, () => Promise.reject(new TypeError('offline')));
  await mount(server);
  await waitFor(() => expect(main().textContent).toMatch(/失败|网络/));
  expect(main().textContent).not.toContain('测试 OAuth 账号');
  await click(button(main(), /重试|重新加载/));
  await loaded();
  expect(server.requests('GET', LIST)).toHaveLength(2);
});

it('[AC-F1-10ga-LIST#6] 10403 显示无权限，不误报空态或要求动态码', async () => {
  const server = createServer();
  server.once('GET', LIST, () => failure(10403, { reason: 'admin_permission_denied' }));
  await mount(server);
  await waitFor(() => expect(main().textContent).toMatch(/无权限|没有.*权限|权限不足/));
  expect(main().textContent).not.toContain('测试 OAuth 账号');
  expect(screen.queryByRole('dialog', { name: /动态码/ })).toBeNull();
  expect(server.requests('POST')).toEqual([]);
});

it('[AC-F1-10ga-LIST#7] 缺 union.account_auth 时直接提示无权限，不读取账号或手机号', async () => {
  const { server } = await mount(createServer(), {
    snapshot: { isSuper: false, permissions: ['order.list'] },
  });
  await waitFor(() => expect(main().textContent).toMatch(/无权限|没有.*权限|权限不足/));
  expect(server.requests('GET', LIST)).toEqual([]);
  expect(server.requests('GET', PHONES)).toEqual([]);
});

it('[AC-F1-10ga-LIST#8] 默认 App 的 /unions 接入账号列表，不依赖 renderPage 注入', async () => {
  const { server } = await mount(createServer(), { app: true });
  await loaded();
  expect(server.requests('GET', LIST)).toHaveLength(1);
  expect(main().textContent).not.toMatch(/页面建设中|待接入/);
});
