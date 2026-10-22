import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiProvider, type AppApiBridge } from '../../../../shared/api/app-api.ts';
import type { H5ApiClient } from '../../../../shared/api/index.ts';
import { createQueryClient, createQueryProvider } from '../../../../shared/query.ts';
import { t } from '../../../../shared/texts.ts';
import { findOrderTexts } from '../../../../texts/find-order.ts';
import { FindOrderPage } from './find-order-page.tsx';
import type { Claim } from './model.ts';

// 单元测试：原生桥、API 客户端都是内存假实现（不联网、不 listen）；auth.changed 经桥传输层的订阅发出。

const clients: ReturnType<typeof createQueryClient>[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

function setup(signed: () => Promise<unknown> = () => Promise.resolve({})) {
  const native = installNative();
  const invalidate = vi.fn();
  const bridge = {
    isInApp: () => true,
    has: (method: string) =>
      method === 'app.getConfig' || method === 'net.signedRequest' ? { method } : null,
    call: (cap: { method: string }) =>
      cap.method === 'app.getConfig' ? Promise.resolve({ values: CONFIG }) : signed(),
    createH5TokenManager: () => ({
      getToken: () =>
        Promise.resolve({ token: 'h5-test', scope: 'read', expire_at: '2099-01-01T00:00:00Z' }),
      invalidate,
    }),
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
        <FindOrderPage bridge={bridge} />
      </ApiProvider>,
      client,
    ),
  );
  return { ...native, view, client, responses, invalidate };
}

async function openRecords(): Promise<void> {
  fireEvent.click(await screen.findByRole('tab', { name: findOrderTexts.tabRecords }));
}

function cachedRecordText(client: ReturnType<typeof createQueryClient>): string {
  return JSON.stringify(client.getQueriesData({ queryKey: ['orders', 'claims'] }));
}

it('[AC-F1-04b-UNIT#15] 账号切换：上一账号的找回记录立即消失、缓存删掉、令牌作废，新账号重新取记录', async () => {
  const { view, client, responses, invalidate, switchAccount } = setup();
  await openRecords();
  await waitFor(() => expect(responses).toHaveLength(1));
  await act(async () => {
    responses[0]!.resolve(page([claim('a-1', 'A111111111111')]));
  });
  await waitFor(() => expect(view.container.textContent).toContain('A111111111111'));

  switchAccount();
  expect(view.container.textContent).not.toContain('A111111111111');
  expect(cachedRecordText(client)).not.toContain('A111111111111');
  expect(invalidate).toHaveBeenCalledTimes(1);

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
