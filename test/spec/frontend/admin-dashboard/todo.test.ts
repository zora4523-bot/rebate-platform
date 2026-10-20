// @vitest-environment jsdom
import { cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CARDS, createServer, dashboard, ok } from './dashboard-fixtures.ts';
import { card, click, loaded, mainElement, mount } from './dashboard-helpers.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('[AC-F1-14a-TODO#1] 服务端裁剪决定卡片：只渲染返回项，不按本地权限再次裁剪或补置灰卡', async () => {
  const data = dashboard();
  const { todo: items } = data;
  items.splice(0, items.length, items[1]!);
  items[0]!.count = 0;
  delete items[0]!.breakdown;
  items[0]!.oldest_at = null;
  delete data.status;
  await mount(createServer(data), {
    permissionsProvider: async () => ({ isSuper: false, permissions: ['dashboard.view'] }),
  });
  await loaded();
  const link = card('待审找回');
  expect(within(mainElement()).queryByRole('link', { name: '待审找回 0，进入找回审核' })).toBe(
    link,
  );
  expect(link.getAttribute('aria-disabled')).not.toBe('true');
  expect(within(link).queryByText('0', { exact: true })).not.toBeNull();
  expect(within(mainElement()).queryAllByRole('link')).toHaveLength(1);
  for (const [, title] of CARDS.filter(([key]) => key !== 'claim_review_pending'))
    expect(
      within(mainElement()).queryByRole('link', {
        name: (name) => name.startsWith(`${title} `),
      }),
    ).toBeNull();
  expect(link.textContent).not.toMatch(/自动匹配待确认|人工审核中|最早|null|undefined/);
});

it('[AC-F1-14a-TODO#2] 全部待办为零仍逐张显示、各有一个可用整卡链接', async () => {
  const data = dashboard();
  const { todo: items } = data;
  Object.assign(data, {
    todo: items.map(({ key, route }) => ({ key, route, count: 0, oldest_at: null })),
  });
  delete data.status;
  await mount(createServer(data));
  await loaded();
  expect(within(mainElement()).queryAllByRole('link')).toHaveLength(8);
  for (const [, title, destination, route] of CARDS) {
    const link = card(title);
    expect(
      within(mainElement()).queryByRole('link', {
        name: `${title} 0，进入${destination}`,
      }),
    ).toBe(link);
    expect(link.getAttribute('href')).toBe(route);
    expect(link.getAttribute('aria-disabled')).not.toBe('true');
    expect(link.querySelectorAll('a,button')).toHaveLength(0);
    expect(within(link).queryByText('0', { exact: true })).not.toBeNull();
  }
});

it('[AC-F1-14a-TODO#3] 千分位、北京时间最早时间及已知细分计数；未知 key 安静忽略', async () => {
  const server = createServer();
  const { todo: items } = server.state;
  items[0]!.count = 12345;
  items[1]!.count = 1035;
  items[1]!.breakdown = [
    { key: 'auto_matched', count: 1012 },
    { key: 'manual_review', count: 23 },
    { key: 'future_bucket', count: 0 },
  ];
  // Simulate a future server enum without widening the production contract type.
  server.once(() =>
    ok({
      ...server.state,
      todo: [...items, { key: 'future_dashboard_card', count: 987654, route: '/future' }],
    }),
  );
  await mount(server);
  await loaded();
  expect(card('待审提现').textContent).toContain('12,345');
  expect(card('待审提现').textContent).toContain('10-11 16:20');
  const claim = card('待审找回');
  expect(claim.textContent).toContain('1,035');
  expect(claim.textContent).toMatch(/自动匹配待确认\s*1,012/);
  expect(claim.textContent).toMatch(/人工审核中\s*23/);
  expect(card('待确认月结账单').textContent).not.toMatch(/最早|null|undefined/);
  expect(mainElement().textContent).not.toMatch(
    /future_bucket|future_dashboard_card|987,654|987654/,
  );
  expect(mainElement().querySelector('a[href="/future"]')).toBeNull();
  expect(within(mainElement()).queryByRole('button', { name: '重试' })).toBeNull();
});

for (const [index, [, title, destination, route]] of CARDS.entries()) {
  it(`[AC-F1-14a-TODO#${index + 4}] ${title} 按服务端 route 保留筛选、落对应未接入占位页`, async () => {
    const server = createServer();
    const { todo: items } = server.state;
    // Add a valid query value to detect hardcoded routes or silently discarded filters.
    const target = `${route}${route.includes('?') ? '&' : '?'}dashboard_probe=case${index}`;
    items[index]!.route = target;
    await mount(server);
    await loaded();
    const link = card(title);
    expect(
      within(mainElement()).queryByRole('link', {
        name: `${title} ${items[index]!.count}，进入${destination}`,
      }),
    ).toBe(link);
    expect(link.getAttribute('href')).toBe(target);
    await click(link);
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe(target));
    await waitFor(() => expect(mainElement().textContent).toContain('尚未接入'));
    expect(within(mainElement()).queryByRole('heading', { name: /昨日概览/ })).toBeNull();
  });
}
