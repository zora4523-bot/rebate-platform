// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { expect, it } from 'vitest';
import {
  coolingError,
  coolingOff,
  deletion,
  list,
  markReadErrors,
  message,
  messagesServer,
  orderId,
  paid,
  reply,
  texts,
  tracked,
} from './messages-fixtures.ts';
import { announcesUnread, entry, mount, rowFor, settle } from './messages-helpers.ts';

it('[AC-F1-04c-OPEN#1] 点开有 route 的消息：nav.open 收到原样 route，并只对这一条标已读', async () => {
  const http = messagesServer({
    list: () => reply(list([tracked, paid])),
    read: () => reply({ marked_count: 1, unread_count: 0 }),
  });
  mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  await settle();
  await userEvent.setup().click(entry(new RegExp(tracked.title)));
  await waitFor(() => expect(http.navigation()).toHaveLength(1));
  expect(http.navigation()[0]!.params).toEqual({
    route: 'OrderDetail',
    params: { order_id: orderId },
  });
  await waitFor(() => expect(http.reads).toHaveLength(1));
  // 请求体恰为 {message_ids:[id]}：不带 all，不夹带别的消息。
  expect(http.reads[0]).toEqual({ message_ids: [tracked.message_id] });
  expect(http.readRequests()[0]!.headers.get('Authorization')).toMatch(/^Bearer /);
  // 标已读成功后该行的未读状态消失。
  await waitFor(() => expect(announcesUnread(rowFor(tracked.body))).toBe(false));
  expect(http.listRequests()).toHaveLength(1);
});

it('[AC-F1-04c-OPEN#2] 路由参数为空或缺省时也原样交给 nav.open；键盘回车可激活', async () => {
  const http = messagesServer({ list: () => reply(list([paid, deletion])) });
  mount(http.api);
  await screen.findByText(paid.body, { exact: false });
  await settle();
  const user = userEvent.setup();
  entry(new RegExp(paid.title)).focus();
  await user.keyboard('{Enter}');
  await user.click(entry(new RegExp(deletion.title)));
  await waitFor(() => expect(http.navigation()).toHaveLength(2));
  const [first, second] = http.navigation().map((request) => request.params) as {
    route: string;
    params?: Record<string, unknown>;
  }[];
  expect(first!.route).toBe('WithdrawRecords');
  expect(first!.params ?? {}).toEqual({});
  expect(second!.route).toBe('DeleteAccount');
  expect(second!.params ?? {}).toEqual({});
  // 不猜路由、不自己拼 URL：只有 nav.open。
  expect(http.bridgeCalls().filter((method) => method.startsWith('nav.'))).toEqual([
    'nav.open',
    'nav.open',
  ]);
});

/** 第二条未读、可点的消息（标题唯一，便于按名找入口）。 */
const rebate = message({
  title: '返利入账',
  body: '你的返利 ¥3.20 已入账',
  route: { route: 'WithdrawRecords', params: {} },
});

it('[AC-F1-04c-OPEN#3] 注销冷静期（D10-542）：点开回 10007 照常跳转、不弹错，「全部已读」消失，此后点开不再标已读', async () => {
  const http = messagesServer({
    list: () => reply(list([tracked, rebate, paid])),
    read: () => coolingOff(),
  });
  const view = mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  // 不预先判断冷静期：进页时「全部已读」照常显示。
  expect(await screen.findByRole('button', { name: texts.readAll })).toBeTruthy();
  const user = userEvent.setup();
  await user.click(entry(new RegExp(tracked.title)));
  await waitFor(() => expect(http.navigation()).toHaveLength(1));
  await waitFor(() => expect(http.reads).toEqual([{ message_ids: [tracked.message_id] }]));
  await waitFor(() => expect(screen.queryByRole('button', { name: texts.readAll })).toBeNull());
  await settle();
  expect(screen.queryByText(texts.readAll, { exact: false })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(view.container.textContent).not.toContain(coolingError);
  expect(document.body.textContent).not.toContain(coolingError);
  // 没有标成已读：未读状态保留。
  expect(announcesUnread(rowFor(tracked.body))).toBe(true);
  // 再点开另一条未读消息：照常跳转，但不再发标已读。
  await user.click(entry(new RegExp(rebate.title)));
  await waitFor(() => expect(http.navigation()).toHaveLength(2));
  expect(http.navigation()[1]!.params).toEqual({ route: 'WithdrawRecords', params: {} });
  await settle();
  expect(http.readRequests()).toHaveLength(1);
  expect(announcesUnread(rowFor(rebate.body))).toBe(true);
  expect(announcesUnread(rowFor(tracked.body))).toBe(true);
  expect(screen.queryByRole('button', { name: texts.readAll })).toBeNull();
  expect(http.deletionRequests()).toEqual([]);
  expect(http.listRequests()).toHaveLength(1);
});

it('[AC-F1-04c-OPEN#4] 不读注销状态（D10-542）：从不请求 GET /v1/me/deletion，点开即按常规标已读', async () => {
  const http = messagesServer({ list: () => reply(list([tracked])) });
  mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  await settle();
  await userEvent.setup().click(entry(new RegExp(tracked.title)));
  await waitFor(() => expect(http.reads).toEqual([{ message_ids: [tracked.message_id] }]));
  expect(http.navigation()).toHaveLength(1);
  await settle();
  expect(http.deletionRequests()).toEqual([]);
  const paths = http.requests.map((request) => new URL(request.url).pathname);
  expect(new Set(paths)).toEqual(new Set(['/v1/messages', '/v1/messages/read']));
});

it('[AC-F1-04c-OPEN#5] 标已读失败但不是 10007（50001）：「全部已读」仍在，再点开仍照常标已读', async () => {
  const http = messagesServer({
    list: () => reply(list([tracked, rebate])),
    read: () => reply(null, 50001, 500),
  });
  mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  await settle();
  const user = userEvent.setup();
  await user.click(entry(new RegExp(tracked.title)));
  await waitFor(() => expect(http.reads.length).toBeGreaterThanOrEqual(1));
  await settle();
  expect(screen.getByRole('button', { name: texts.readAll })).toBeTruthy();
  await user.click(entry(new RegExp(rebate.title)));
  await waitFor(() => expect(http.reads).toContainEqual({ message_ids: [rebate.message_id] }));
  expect(http.navigation()).toHaveLength(2);
});

const markReadFailures: [code: keyof typeof markReadErrors, status: number, data: unknown][] = [
  [10403, 403, { reason: 'h5_read_only' }],
  [20001, 400, { fields: ['message_ids'] }],
  [10405, 403, null],
  [50001, 500, null],
];

it.each(markReadFailures)(
  '[AC-F1-04c-OPEN#6] 标已读失败（%i）不影响跳转与浏览，不弹错',
  async (code, status, data) => {
    const http = messagesServer(
      {
        list: () => reply(list([tracked, paid])),
        read: () => reply(data, code, status),
      },
      code === 10403 ? { scope: 'read_only' } : {},
    );
    const view = mount(http.api);
    await screen.findByText(tracked.body, { exact: false });
    await settle();
    await userEvent.setup().click(entry(new RegExp(tracked.title)));
    await waitFor(() => expect(http.navigation()).toHaveLength(1));
    await waitFor(() => expect(http.reads.length).toBeGreaterThanOrEqual(1));
    await settle();
    expect(http.navigation()[0]!.params).toEqual({
      route: 'OrderDetail',
      params: { order_id: orderId },
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(view.container.textContent).not.toContain(markReadErrors[code]);
    expect(document.body.textContent).not.toContain(markReadErrors[code]);
    expect(document.body.textContent).not.toContain(markReadErrors[50001]);
    // 列表照常可浏览：其余消息仍在，且没有被换成错误页。
    expect(screen.getByText(paid.body, { exact: false })).toBeTruthy();
    expect(screen.getByText(tracked.body, { exact: false })).toBeTruthy();
    expect(http.listRequests()).toHaveLength(1);
  },
);

it('[AC-F1-04c-OPEN#7] 标已读请求未返回时跳转不等待它', async () => {
  const pending = Promise.withResolvers<Response>();
  const http = messagesServer({
    list: () => reply(list([tracked])),
    read: () => pending.promise,
  });
  mount(http.api);
  await screen.findByText(tracked.body, { exact: false });
  await settle();
  await userEvent.setup().click(entry(new RegExp(tracked.title)));
  await waitFor(() => expect(http.navigation()).toHaveLength(1));
  await act(async () => {
    pending.resolve(reply({ marked_count: 1, unread_count: 0 }));
  });
});
