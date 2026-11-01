// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { MessagesPage } from '../../../../apps/h5/src/entries/app/pages/messages/index.ts';
import { createAppRoutes } from '../../../../apps/h5/src/entries/app/routes.ts';
import {
  deletion,
  list,
  message,
  messagesServer,
  paid,
  reply,
  risk,
  tracked,
} from './messages-fixtures.ts';
import {
  announcesUnread,
  compact,
  expectListQuery,
  mount,
  rowFor,
  settle,
} from './messages-helpers.ts';

it('[AC-F1-04c-LIST#1] Messages 路由（/messages）懒加载真实消息中心页面', async () => {
  const route = createAppRoutes().find((item) => item.path === '/messages');
  expect(route).toBeDefined();
  expect((await route!.lazy()).Component).toBe(MessagesPage);
});

it('[AC-F1-04c-LIST#2] 经桥取 H5 令牌后请求第一页，按服务端顺序显示标题与正文', async () => {
  const http = messagesServer();
  const view = mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  for (const item of [tracked, paid, risk, deletion]) {
    const row = rowFor(item.body);
    expect(row.textContent).toContain(item.title);
  }
  // 服务端顺序即显示顺序（新的在前），客户端不重排。
  const order = [tracked, paid, risk, deletion].map((item) => rowFor(item.body));
  for (let index = 1; index < order.length; index += 1) {
    expect(
      order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  }
  expect(http.listRequests()).toHaveLength(1);
  expectListQuery(http.listRequests()[0]!);
  expect(http.tokenCalls()).toBe(1);
  expect(http.listRequests()[0]!.headers.get('Authorization')).toBe('Bearer messages-token-1');
  // 进页只读列表：列表不改已读，不调标已读。
  expect(http.readRequests()).toEqual([]);
  expect(view.container.textContent).not.toMatch(/null|undefined|NaN|Invalid Date/);
});

it('[AC-F1-04c-LIST#3] 进页不请求 GET /v1/me/deletion（H5 令牌无权读，D10-542），只读列表、不签名', async () => {
  const http = messagesServer();
  mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  await settle();
  expect(http.deletionRequests()).toEqual([]);
  const paths = http.requests.map((request) => new URL(request.url).pathname);
  expect(new Set(paths)).toEqual(new Set(['/v1/messages']));
  expect(http.bridgeCalls()).not.toContain('net.signedRequest');
});

it('[AC-F1-04c-ROW#1] 未读行读屏可读出「未读」，已读行没有', async () => {
  const http = messagesServer();
  mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  expect(announcesUnread(rowFor(tracked.body))).toBe(true);
  expect(announcesUnread(rowFor(risk.body))).toBe(true);
  expect(announcesUnread(rowFor(paid.body))).toBe(false);
  expect(announcesUnread(rowFor(deletion.body))).toBe(false);
});

it('[AC-F1-04c-ROW#2] 时间按 BR-TEXT-11：今天 / 昨天带时刻，同年更早写月-日，跨年写年月日', async () => {
  const http = messagesServer();
  mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  const today = compact(rowFor(tracked.body));
  expect(today).toContain('今天09:05');
  const yesterday = compact(rowFor(paid.body));
  expect(yesterday).toContain('昨天23:59');
  const earlier = compact(rowFor(risk.body));
  expect(earlier).toContain('09-27');
  expect(earlier).not.toMatch(/2026-09-27|14:03|今天|昨天/);
  const lastYear = compact(rowFor(deletion.body));
  expect(lastYear).toContain('2025-12-31');
  expect(lastYear).not.toMatch(/08:00|今天|昨天/);
});

it('[AC-F1-04c-ROW#3] 「今天 / 昨天」按上海日期判断，不按 UTC 日期或 24 小时窗口', async () => {
  const http = messagesServer({
    list: () =>
      reply(
        list([
          // 上海 2026-10-22 00:30（UTC 仍是 10-21）→ 今天 00:30
          message({ body: '凌晨的消息', created_at: '2026-10-21T16:30:00Z' }),
          // 上海 2026-10-21 00:00 → 昨天 00:00
          message({ body: '昨天零点的消息', created_at: '2026-10-21T00:00:00+08:00' }),
          // 上海 2026-10-20 23:59（距现在不足 37 小时，但已是前天）→ 10-20
          message({ body: '前天深夜的消息', created_at: '2026-10-20T23:59:59+08:00' }),
          // 上海 2026-01-01 00:00（UTC 仍是 2025 年）→ 同年 01-01
          message({ body: '元旦的消息', created_at: '2025-12-31T16:00:00Z' }),
        ]),
      ),
  });
  mount(http.api);
  await screen.findByText('凌晨的消息', { exact: false });
  expect(compact(rowFor('凌晨的消息'))).toContain('今天00:30');
  expect(compact(rowFor('昨天零点的消息'))).toContain('昨天00:00');
  const dayBefore = compact(rowFor('前天深夜的消息'));
  expect(dayBefore).toContain('10-20');
  expect(dayBefore).not.toMatch(/昨天|今天|23:59/);
  const newYear = compact(rowFor('元旦的消息'));
  expect(newYear).toContain('01-01');
  expect(newYear).not.toMatch(/2025|2026-01-01|00:00/);
});

it('[AC-F1-04c-ROW#4] 没有 route 的消息不可点：不是按钮或链接，点击与回车都不跳转、不标已读', async () => {
  const http = messagesServer({ list: () => reply(list([risk, tracked])) });
  mount(http.api);
  await screen.findByText(risk.body, { exact: false });
  const row = rowFor(risk.body);
  expect(row.matches('a, button, [role="button"], [role="link"]')).toBe(false);
  expect(row.querySelector('a, button, [role="button"], [role="link"]')).toBeNull();
  expect(screen.queryAllByRole('button', { name: new RegExp(risk.title) })).toEqual([]);
  expect(screen.queryAllByRole('link', { name: new RegExp(risk.title) })).toEqual([]);
  const user = userEvent.setup();
  await user.click(screen.getByText(risk.body, { exact: false }));
  await user.click(row);
  await user.keyboard('{Enter} ');
  await settle();
  expect(http.navigation()).toEqual([]);
  expect(http.readRequests()).toEqual([]);
  expect(announcesUnread(rowFor(risk.body))).toBe(true);
});

it('[AC-F1-04c-ROW#5] 有 route 的行是可访问的按钮或链接，可访问名含标题', async () => {
  const http = messagesServer({ list: () => reply(list([tracked, paid])) });
  mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  for (const item of [tracked, paid]) {
    const controls = [
      ...screen.queryAllByRole('button', { name: new RegExp(item.title) }),
      ...screen.queryAllByRole('link', { name: new RegExp(item.title) }),
    ];
    expect(controls).toHaveLength(1);
    const row = rowFor(item.body);
    expect(row.contains(controls[0]!) || controls[0]!.contains(row)).toBe(true);
  }
});
