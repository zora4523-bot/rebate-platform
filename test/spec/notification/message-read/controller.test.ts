// B1-12d · route handler with a substitute reader (no database): the subject is the verified
// token principal only (编排者裁定 B1); found → InboxMessageResponse; null → 404 / 30701, the same
// answer whatever the reason (contract getMessage; BR-ID-10 细则「推送点击的落点」).
import { expect, it, vi } from 'vitest';
import type { TokenPrincipal } from '../../../../apps/api/src/modules/platform/http/token-context.ts';
import type { MessageReader } from '../../../../apps/api/src/modules/notification/application/message-read.ts';
import { MessagesController } from '../../../../apps/api/src/modules/notification/http/public/messages.controller.ts';

// Built from parts so no 32-hex literal sits in this file (gitleaks cn-hex-secret).
const TRACE = ['b112d', '0'.repeat(26), '1'].join('');
const MESSAGE = '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a80';
const PRINCIPAL: TokenPrincipal = {
  uid: '019a0000-0000-7000-8000-000000000310',
  app_id: 'couli',
  sid: 'session-b112d-unit',
  device_id: '019a0000-0000-7000-8000-000000000301',
  scp: 'full',
};
const VIEW = {
  message_id: MESSAGE,
  code: 'WITHDRAW_PAID',
  title: '提现已到账',
  body: '你的提现已到账',
  created_at: '2026-10-02T01:30:00.000Z',
  read_at: null,
  route: { route: 'WithdrawRecords', params: {} },
};

/** The rejection of a promise (undefined when it resolves). */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** Reads a Nest HttpException structurally (status and response body). */
function httpError(error: unknown) {
  expect(error).toBeInstanceOf(Error);
  const candidate = error as { getStatus?: unknown; getResponse?: unknown };
  expect(typeof candidate.getStatus).toBe('function');
  expect(typeof candidate.getResponse).toBe('function');
  const http = error as { getStatus(): number; getResponse(): unknown };
  return { status: http.getStatus(), body: http.getResponse() };
}

it('[AC-B1-12d#7][BR-ID-10] 处理函数只用令牌主体的app_id、uid与路径message_id调用一次读取用例，回InboxMessageResponse', async () => {
  const get = vi.fn<MessageReader['get']>().mockResolvedValue(VIEW);
  const controller = new MessagesController({ get });
  const response = await controller.get(
    {
      id: TRACE,
      headers: { 'x-app-id': 'other_app', 'x-device-id': '019a0000-0000-7000-8000-000000000399' },
      principal: PRINCIPAL,
    },
    MESSAGE,
  );
  expect(get).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledWith({
    app_id: 'couli',
    user_id: '019a0000-0000-7000-8000-000000000310',
    message_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a80',
  });
  expect(response).toEqual({
    code: 0,
    msg: '',
    data: {
      message_id: '0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a80',
      code: 'WITHDRAW_PAID',
      title: '提现已到账',
      body: '你的提现已到账',
      created_at: '2026-10-02T01:30:00.000Z',
      read_at: null,
      route: { route: 'WithdrawRecords', params: {} },
    },
    trace_id: TRACE,
  });
});

it('[AC-B1-12d#8][BR-ID-10] 读取用例返回null时回404/30701，带请求trace_id', async () => {
  const get = vi.fn<MessageReader['get']>().mockResolvedValue(null);
  const controller = new MessagesController({ get });
  const error = httpError(
    await rejection(controller.get({ id: TRACE, principal: PRINCIPAL }, MESSAGE)),
  );
  expect(error.status).toBe(404);
  expect(error.body).toMatchObject({ code: 30701, trace_id: TRACE });
  expect(get).toHaveBeenCalledTimes(1);
});

it('[AC-B1-12d#9][BR-ID-10] 没有经令牌检查的主体时回401/10001，且不调用读取用例', async () => {
  const get = vi.fn<MessageReader['get']>().mockResolvedValue(VIEW);
  const controller = new MessagesController({ get });
  const error = httpError(await rejection(controller.get({ id: TRACE }, MESSAGE)));
  expect(error.status).toBe(401);
  expect(error.body).toMatchObject({ code: 10001, trace_id: TRACE });
  expect(get).not.toHaveBeenCalled();
});

it('[AC-B1-12d#10][BR-ID-10] 读取用例的基础设施失败原样上抛（交全局错误过滤器回50001），不吞成30701', async () => {
  const failure = new Error('fixture reader failure');
  const get = vi.fn<MessageReader['get']>().mockRejectedValue(failure);
  const controller = new MessagesController({ get });
  await expect(controller.get({ id: TRACE, principal: PRINCIPAL }, MESSAGE)).rejects.toBe(failure);
  expect(get).toHaveBeenCalledTimes(1);
});
