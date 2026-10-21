// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LIST, LOOKUP, PHONE, REASON, REVEAL, VERIFY, UID, createServer } from './fixtures.ts';
import {
  FLOW_TIMEOUT,
  detailLoaded,
  loaded,
  lookup,
  mainElement,
  mount,
  openDetail,
  searchBox,
  settled,
  startReveal,
  verify,
} from './helpers.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('[AC-F1-07i-PERMISSION#1] 只有 user.lookup 时只显示查找，命中可读详情且不请求列表', async () => {
  const { server } = await mount(createServer(), { isSuper: false, permissions: ['user.lookup'] });
  expect(searchBox()).toBeDefined();
  expect(within(mainElement()).queryAllByRole('table')).toEqual([]);
  expect(within(mainElement()).queryByRole('combobox', { name: /风控状态/ })).toBeNull();
  expect(mainElement().textContent).not.toMatch(/无权限|没有.*权限|权限不足/);
  await lookup(UID);
  await detailLoaded();
  await settled(server);
  expect(server.requests('GET', LOOKUP)).toHaveLength(1);
  expect(server.requests('GET', LIST)).toEqual([]);
});

it('[AC-F1-07i-PERMISSION#2] 只有 user.list 时不显示查找框，仍可读取列表与详情', async () => {
  const { server } = await mount(createServer(), { isSuper: false, permissions: ['user.list'] });
  await loaded();
  expect(within(mainElement()).queryAllByRole('textbox')).toEqual([]);
  await openDetail();
  await detailLoaded();
  expect(server.requests('GET', LIST)).toHaveLength(1);
  expect(server.requests('GET', LOOKUP)).toEqual([]);
});

it('[AC-F1-07i-PERMISSION#3] 无 pii.reveal_phone 时基础投影仍可见但没有查看按钮', async () => {
  const { server } = await mount(createServer(), { isSuper: false, permissions: ['user.list'] });
  await openDetail();
  await detailLoaded();
  expect(mainElement().textContent).toContain('138****5678');
  // The reveal entry is 查看 / 查看完整手机号 (as in [AC-F1-07j-NOPE#2]); 查看直推名单 (CT-24e, user.list)
  // is a different, permitted entry.
  expect(within(mainElement()).queryAllByRole('button', { name: /^查看(?:完整手机号)?$/ })).toEqual(
    [],
  );
  expect(server.requests('POST')).toEqual([]);
});

it('[AC-F1-07i-PERMISSION#4] 没有两个读取权限时页面自身显示无权限且不发请求', async () => {
  const { server } = await mount(createServer(), {
    isSuper: false,
    permissions: ['pii.reveal_phone'],
  });
  await waitFor(() => expect(mainElement().textContent).toMatch(/无权限|没有.*权限|权限不足/));
  expect(within(mainElement()).queryAllByRole('textbox')).toEqual([]);
  expect(server.log).toEqual([]);
  cleanup();
  // Also guard direct navigation through the production shell with unrelated permissions.
  await mount(server, { isSuper: false, permissions: ['pii.reveal_phone'] }, true);
  await waitFor(() => expect(mainElement().textContent).toMatch(/无权限|没有.*权限|权限不足/));
  expect(server.log).toEqual([]);
});

it(
  '[AC-F1-07i-PERMISSION#5] 普通账号有 user.list 与 pii.reveal_phone 时可经 totp 查看完整手机号',
  async () => {
    const { server } = await mount(createServer(), {
      isSuper: false,
      permissions: ['user.list', 'pii.reveal_phone'],
    });
    await openDetail();
    await detailLoaded();
    expect(
      within(mainElement()).getByRole('button', { name: /^查看(?:完整手机号)?$/ }),
    ).toBeDefined();
    expect(mainElement().textContent).not.toContain(PHONE);
    const modal = await startReveal();
    expect(server.requests('POST')).toEqual([]);
    await verify(modal);
    await waitFor(() => expect(mainElement().textContent).toContain(PHONE));
    await settled(server);
    expect(server.requests('POST').map((request) => request.path)).toEqual([VERIFY, REVEAL]);
    expect(server.requests('POST', VERIFY)[0]!.body).toEqual({ tier: 'totp', code: '123456' });
    const request = server.requests('POST', REVEAL)[0]!;
    expect(request.headers.get('X-Step-Up-Token')).toBe('test-totp-1');
    expect(request.body).toEqual({ field: 'phone', reason: REASON });
    expect(server.requests('GET', LOOKUP)).toEqual([]);
  },
  FLOW_TIMEOUT,
);
