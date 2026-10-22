import { on } from '@couli/bridge-sdk';
import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiProvider, type AppApiBridge } from '../../../../shared/api/app-api.ts';
import { ApiError, type H5ApiClient } from '../../../../shared/api/index.ts';
import {
  clearAccountData,
  createQueryClient,
  createQueryProvider,
} from '../../../../shared/query.ts';
import { t } from '../../../../shared/texts.ts';
import { findOrderTexts } from '../../../../texts/find-order.ts';
import { FindOrderPage } from './find-order-page.tsx';
import type { Claim } from './model.ts';

// 单元测试：原生桥、API 客户端都是内存假实现（不联网、不 listen）；auth.changed 经桥传输层的订阅发出。
// 账号切换的全局清理归壳层（F1-01s）：这里用与壳层同样的做法（clearAccountData + 按次数重挂页面树）
// 包住本页，验证本页在壳层清理下不露出上一账号的数据、迟到结果不写进新账号；本页自己不再订阅该事件。

/** 与 app-shell 的 AccountScope 同样的账号切换处理：清缓存、换 key 重挂子树。 */
function AccountScope({ client, children }: { client: QueryClient; children: ReactNode }) {
  const [epoch, setEpoch] = useState(0);
  useEffect(
    () =>
      on('auth.changed', () => {
        clearAccountData(client);
        setEpoch((current) => current + 1);
      }),
    [client],
  );
  return <div key={epoch}>{children}</div>;
}

const clients: ReturnType<typeof createQueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  onlineManager.setOnline(true);
});

const CONFIG = {
  features: { flags: {}, platform_status: { taobao: 'on', jd: 'on', pdd: 'on' } },
  claim: { window_days: 17 },
  help_links: {},
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function claim(id: string, orderNo: string): Claim {
  return {
    claim_id: id,
    platform: 'taobao',
    order_no: orderNo,
    paid_date: '2026-10-06',
    status: 'manual_review',
    created_at: '2026-10-07T10:15:00+08:00',
    items: [{ sub_order_id: orderNo, decision: null, reject_reason: null }],
  };
}

function page(items: Claim[]) {
  return { items, next_cursor: null };
}

/** 原生传输层：只用来发事件（页面的方法调用走注入的 bridge）。 */
function installNative() {
  const listeners = new Set<(event: unknown) => void>();
  vi.stubGlobal('__REBATE_BRIDGE__', {
    version: 1,
    methods: [],
    postMessage: () => undefined,
    subscribe(listener: (event: unknown) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return {
    switchAccount() {
      act(() => {
        for (const listener of listeners)
          listener({ event: 'auth.changed', data: { logged_in: true } });
      });
    },
  };
}

function okToken(): Promise<unknown> {
  return Promise.resolve({ token: 'h5-test', scope: 'read', expire_at: '2099-01-01T00:00:00Z' });
}

function setup(
  signed: () => Promise<unknown> = () => Promise.resolve({}),
  shell = true,
  token: () => Promise<unknown> = okToken,
) {
  const native = installNative();
  const getToken = vi.fn(token);
  const createH5TokenManager = vi.fn(() => ({ getToken, invalidate: vi.fn() }));
  const call = vi.fn((cap: { method: string }) =>
    cap.method === 'app.getConfig' ? Promise.resolve({ values: CONFIG }) : signed(),
  );
  const bridge = {
    isInApp: () => true,
    has: (method: string) =>
      method === 'app.getConfig' || method === 'net.signedRequest' ? { method } : null,
    call,
    createH5TokenManager,
  } as unknown as AppApiBridge;
  const responses: Deferred<unknown>[] = [];
  const api = {
    request: vi.fn(() => {
      const next = deferred<unknown>();
      responses.push(next);
      return next.promise;
    }),
  } as unknown as H5ApiClient;
  const client = createQueryClient();
  clients.push(client);
  const view = render(
    createQueryProvider(
      <ApiProvider api={api}>
        {shell ? (
          <AccountScope client={client}>
            <FindOrderPage bridge={bridge} />
          </AccountScope>
        ) : (
          <FindOrderPage bridge={bridge} />
        )}
      </ApiProvider>,
      client,
    ),
  );
  return { ...native, view, client, responses, createH5TokenManager, getToken, call, api };
}

async function openRecords(): Promise<void> {
  fireEvent.click(await screen.findByRole('tab', { name: findOrderTexts.tabRecords }));
}

function cachedRecordText(client: ReturnType<typeof createQueryClient>): string {
  return JSON.stringify(client.getQueriesData({ queryKey: ['orders', 'claims'] }));
}

it('[AC-F1-04b-UNIT#15] 壳层换号重挂：上一账号的找回记录立即消失、缓存删掉、本页换新令牌管理器，新账号重新取记录', async () => {
  const { view, client, responses, createH5TokenManager, switchAccount } = setup();
  await openRecords();
  await waitFor(() => expect(responses).toHaveLength(1));
  await act(async () => {
    responses[0]!.resolve(page([claim('a-1', 'A111111111111')]));
  });
  await waitFor(() => expect(view.container.textContent).toContain('A111111111111'));
  expect(createH5TokenManager).toHaveBeenCalledTimes(1);

  switchAccount();
  expect(view.container.textContent).not.toContain('A111111111111');
  expect(cachedRecordText(client)).not.toContain('A111111111111');
  expect(createH5TokenManager).toHaveBeenCalledTimes(2);

  // 页面树重挂后回到默认页签；再进记录页签由新账号重新取。
  await openRecords();
  await waitFor(() => expect(responses).toHaveLength(2));
  expect(view.container.textContent).not.toContain('A111111111111');
  await act(async () => {
    responses[1]!.resolve(page([claim('b-1', 'B222222222222')]));
  });
  await waitFor(() => expect(view.container.textContent).toContain('B222222222222'));
  expect(view.container.textContent).not.toContain('A111111111111');
});

it('[AC-F1-04b-UNIT#16] 账号切换前发出的记录请求切换后才返回：结果不显示、不进缓存', async () => {
  const { view, client, responses, switchAccount } = setup();
  await openRecords();
  await waitFor(() => expect(responses).toHaveLength(1));

  switchAccount();
  await openRecords();
  await waitFor(() => expect(responses).toHaveLength(2));
  await act(async () => {
    responses[0]!.resolve(page([claim('a-1', 'A111111111111')]));
  });
  expect(view.container.textContent).not.toContain('A111111111111');
  expect(cachedRecordText(client)).not.toContain('A111111111111');

  await act(async () => {
    responses[1]!.resolve(page([claim('b-1', 'B222222222222')]));
  });
  await waitFor(() => expect(view.container.textContent).toContain('B222222222222'));
  expect(view.container.textContent).not.toContain('A111111111111');
  expect(cachedRecordText(client)).not.toContain('A111111111111');
});

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: findOrderTexts.submit });
}

async function fillAndSubmit(): Promise<void> {
  fireEvent.change(await screen.findByLabelText(findOrderTexts.orderLabel), {
    target: { value: '3712345678901234567' },
  });
  fireEvent.change(screen.getByLabelText(findOrderTexts.paidDateLabel), {
    target: { value: '2026-10-02' },
  });
  await act(async () => {
    fireEvent.click(submitButton());
  });
}

function rejected(code: number) {
  return { status: 422, headers: {}, body: { code, msg: '', data: null } };
}

it('[AC-F1-04b-UNIT#17] 上一账号 30203 当天置灰：切换账号后解除，输入与错误清空', async () => {
  const { view, switchAccount } = setup(() => Promise.resolve(rejected(30203)));
  await fillAndSubmit();
  await waitFor(() => expect(submitButton().disabled).toBe(true));
  expect(view.container.textContent).toContain(t('error.30203'));

  switchAccount();
  const order = (await screen.findByLabelText(findOrderTexts.orderLabel)) as HTMLInputElement;
  expect(order.value).toBe('');
  expect((screen.getByLabelText(findOrderTexts.paidDateLabel) as HTMLInputElement).value).toBe('');
  expect(submitButton().disabled).toBe(false);
  expect(view.container.textContent).not.toContain(t('error.30203'));
});

it('[AC-F1-04b-UNIT#18] 切换前提交、切换后才返回的 30206 不让新账号置灰', async () => {
  const pending = deferred<unknown>();
  const { view, switchAccount } = setup(() => pending.promise);
  await fillAndSubmit();
  expect(submitButton().disabled).toBe(true);

  switchAccount();
  await screen.findByLabelText(findOrderTexts.orderLabel);
  await act(async () => {
    pending.resolve(rejected(30206));
  });
  expect(submitButton().disabled).toBe(false);
  expect(view.container.textContent).not.toContain(t('error.30206'));
});

it('[AC-F1-04b-UNIT#19] 本页不自己订阅 auth.changed：不取消、不删除查询（全局清理只由壳层做一次）', async () => {
  const { client, responses, switchAccount } = setup(undefined, false);
  await openRecords();
  await waitFor(() => expect(responses).toHaveLength(1));
  const cancel = vi.spyOn(client, 'cancelQueries');
  const remove = vi.spyOn(client, 'removeQueries');
  const clear = vi.spyOn(client, 'clear');
  switchAccount();
  expect(cancel).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(clear).not.toHaveBeenCalled();
});

/** 模拟手机断网再恢复（TanStack 的 onlineManager 恢复时会触发 refetchOnReconnect）。 */
async function dropAndRestoreNetwork(): Promise<void> {
  await act(async () => {
    onlineManager.setOnline(false);
    await Promise.resolve();
  });
  await act(async () => {
    onlineManager.setOnline(true);
    await new Promise((done) => setTimeout(done, 50));
  });
}

function configCalls(call: ReturnType<typeof setup>['call']): number {
  return call.mock.calls.filter(([cap]) => cap.method === 'app.getConfig').length;
}

it('[AC-F1-04b-UNIT#20] 进页取令牌返回 10405：断网再恢复不自动重取令牌、配置，也不发请求', async () => {
  const { getToken, call, api } = setup(undefined, true, () =>
    Promise.reject(new ApiError(10405, '')),
  );
  await screen.findByRole('button', { name: t('h5.retry') });
  expect(getToken).toHaveBeenCalledTimes(1);
  expect(configCalls(call)).toBe(1);

  await dropAndRestoreNetwork();
  expect(getToken).toHaveBeenCalledTimes(1);
  expect(configCalls(call)).toBe(1);
  expect(call).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.request)).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: t('h5.retry') })).toBeTruthy();
});

it('[AC-F1-04b-UNIT#21] 找回记录返回 10405：断网再恢复不自动重取记录，也不再取令牌、配置', async () => {
  const { getToken, call, api, responses } = setup();
  await openRecords();
  await waitFor(() => expect(responses).toHaveLength(1));
  await act(async () => {
    responses[0]!.resolve(Promise.reject(new ApiError(10405, '')));
  });
  await screen.findByRole('button', { name: t('h5.retry') });
  const tokens = getToken.mock.calls.length;
  const calls = call.mock.calls.length;

  await dropAndRestoreNetwork();
  expect(vi.mocked(api.request)).toHaveBeenCalledTimes(1);
  expect(responses).toHaveLength(1);
  expect(getToken).toHaveBeenCalledTimes(tokens);
  expect(call).toHaveBeenCalledTimes(calls);
  expect(configCalls(call)).toBe(1);
});
