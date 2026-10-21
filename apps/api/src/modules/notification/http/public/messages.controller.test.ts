// B1-12k implementer unit tests: the inbox handlers with a substitute port (no database).
import { expect, it, vi } from 'vitest';
import type { TokenPrincipal } from '../../../platform/index.ts';
import { InboxCursorError, type InboxMessages } from '../../application/inbox-messages.ts';
import type { MessageReader } from '../../application/message-read.ts';
import { MessagesController } from './messages.controller.ts';

const TRACE = 'trace-b112k-unit';
const PRINCIPAL: TokenPrincipal = {
  uid: '019a0000-0000-7000-8000-000000000410',
  app_id: 'couli',
  sid: 'session-b112k-unit',
  device_id: '019a0000-0000-7000-8000-000000000401',
  scp: 'full',
};
const OWNER = { app_id: 'couli', user_id: '019a0000-0000-7000-8000-000000000410' };

function controllerWith(inbox: Partial<InboxMessages>) {
  const reader: MessageReader = { get: vi.fn() };
  const port: InboxMessages = {
    list: vi.fn(),
    markRead: vi.fn(),
    unreadCount: vi.fn(),
    ...inbox,
  };
  return { controller: new MessagesController(reader, port), port };
}

async function rejection(promise: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  const http = error as { getStatus(): number; getResponse(): unknown };
  expect(typeof http.getStatus).toBe('function');
  return { status: http.getStatus(), body: http.getResponse() };
}

it('[AC-B1-12k#9] list passes only the principal owner, cursor and limit to the port', async () => {
  const list = vi.fn<InboxMessages['list']>().mockResolvedValue({ items: [], next_cursor: null });
  const { controller } = controllerWith({ list });
  const response = await controller.list({
    id: TRACE,
    headers: { 'x-app-id': 'other_app' },
    principal: PRINCIPAL,
    query: { cursor: 'abc', limit: 5 },
  });
  expect(list).toHaveBeenCalledWith({ ...OWNER, cursor: 'abc', limit: 5 });
  expect(response).toEqual({
    code: 0,
    msg: '',
    data: { items: [], next_cursor: null },
    trace_id: TRACE,
  });
});

it('[AC-B1-12k#10] an InboxCursorError becomes 400 / 20001 fields [cursor]', async () => {
  const list = vi.fn<InboxMessages['list']>().mockRejectedValue(new InboxCursorError());
  const { controller } = controllerWith({ list });
  const refused = await rejection(
    controller.list({ id: TRACE, principal: PRINCIPAL, query: { cursor: 'bad' } }),
  );
  expect(refused.status).toBe(400);
  expect(refused.body).toMatchObject({
    code: 20001,
    data: { fields: ['cursor'] },
    trace_id: TRACE,
  });
});

it('[AC-B1-12k#4] markRead and unreadCount use the principal, never body identity', async () => {
  const markRead = vi
    .fn<InboxMessages['markRead']>()
    .mockResolvedValue({ marked_count: 2, unread_count: 1 });
  const unreadCount = vi.fn<InboxMessages['unreadCount']>().mockResolvedValue({ unread_count: 1 });
  const { controller } = controllerWith({ markRead, unreadCount });
  const marked = await controller.markRead({ id: TRACE, principal: PRINCIPAL }, { all: true });
  expect(markRead).toHaveBeenCalledWith({ ...OWNER, all: true });
  expect(marked.data).toEqual({ marked_count: 2, unread_count: 1 });
  await controller.markRead({ id: TRACE, principal: PRINCIPAL }, { message_ids: ['m1'] });
  expect(markRead).toHaveBeenLastCalledWith({ ...OWNER, message_ids: ['m1'] });
  const count = await controller.unreadCount({ id: TRACE, principal: PRINCIPAL });
  expect(unreadCount).toHaveBeenCalledWith(OWNER);
  expect(count).toEqual({ code: 0, msg: '', data: { unread_count: 1 }, trace_id: TRACE });
});

it('[AC-B1-12k#8] without a principal every inbox handler answers 401 / 10001 and calls nothing', async () => {
  const { controller, port } = controllerWith({});
  for (const call of [
    controller.list({ id: TRACE }),
    controller.markRead({ id: TRACE }, { all: true }),
    controller.unreadCount({ id: TRACE }),
  ]) {
    const refused = await rejection(call);
    expect(refused.status).toBe(401);
    expect(refused.body).toMatchObject({ code: 10001 });
  }
  expect(port.list).not.toHaveBeenCalled();
  expect(port.markRead).not.toHaveBeenCalled();
  expect(port.unreadCount).not.toHaveBeenCalled();
});
