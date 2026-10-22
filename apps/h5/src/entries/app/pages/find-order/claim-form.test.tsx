import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { AppApiBridge } from '../../../../shared/api/app-api.ts';
import { createQueryClient, createQueryProvider } from '../../../../shared/query.ts';
import { t } from '../../../../shared/texts.ts';
import { findOrderTexts } from '../../../../texts/find-order.ts';
import { ClaimForm } from './claim-form.tsx';
import type { ClaimConfig } from './model.ts';

// 单元测试：桥是内存假实现（不联网、不 listen）；只假 Date 与计时器，不碰真实时钟。

const CONFIG: ClaimConfig = { platforms: ['taobao', 'jd', 'pdd'], windowDays: 17, guides: {} };

// 提交结果的解析块在应用里由表单挂载时预取；这里先载入，断言不必等首次转换模块。
beforeAll(async () => {
  await import('./submit.ts');
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function fakeBridge(code: number, data: unknown = null) {
  const calls: unknown[] = [];
  const bridge = {
    isInApp: () => true,
    has: (method: string) => (method === 'net.signedRequest' ? { method } : null),
    call: (_cap: unknown, params: unknown) => {
      calls.push(params);
      return Promise.resolve({ status: 422, headers: {}, body: { code, msg: '', data } });
    },
    createH5TokenManager: () => {
      throw new Error('not used');
    },
  } as unknown as AppApiBridge;
  return { bridge, calls };
}

function mount(client: ReturnType<typeof createQueryClient>, bridge: AppApiBridge) {
  return render(
    createQueryProvider(
      <ClaimForm bridge={bridge} config={CONFIG} onCreated={() => {}} onDuplicate={() => {}} />,
      client,
    ),
  );
}

function button(): HTMLButtonElement {
  return screen.getByRole('button', { name: findOrderTexts.submit }) as HTMLButtonElement;
}

async function submit(): Promise<void> {
  fireEvent.change(screen.getByLabelText(findOrderTexts.orderLabel), {
    target: { value: '3712345678901234567' },
  });
  fireEvent.change(screen.getByLabelText(findOrderTexts.paidDateLabel), {
    target: { value: '2026-10-20' },
  });
  await act(async () => {
    fireEvent.click(button());
  });
}

it('[AC-F1-04b-UNIT#12] 30203 置灰离开再进页仍在（同一天），上海次日再进页解除，不显示次数', async () => {
  vi.setSystemTime(new Date('2026-10-22T10:00:00+08:00'));
  const client = createQueryClient();
  const { bridge, calls } = fakeBridge(30203);
  const first = mount(client, bridge);
  await submit();
  expect(calls).toHaveLength(1);
  expect(button().disabled).toBe(true);
  expect(first.container.textContent).toContain(t('error.30203'));
  expect(first.container.textContent).not.toMatch(/\d+\s*次/);
  first.unmount();

  // 当天稍后、远超缓存默认回收时间再进页：仍置灰，提交不发请求。
  act(() => {
    vi.advanceTimersByTime(13 * 60 * 60 * 1000);
  });
  expect(new Date().toISOString()).toBe('2026-10-22T15:00:00.000Z');
  const again = mount(client, bridge);
  expect(button().disabled).toBe(true);
  expect(again.container.textContent).toContain(t('error.30203'));
  await act(async () => {
    fireEvent.submit(button().closest('form')!);
  });
  expect(calls).toHaveLength(1);
  again.unmount();

  // 上海次日再进页：解除，可再次提交。
  vi.setSystemTime(new Date('2026-10-23T00:00:01+08:00'));
  const next = mount(client, bridge);
  expect(button().disabled).toBe(false);
  expect(next.container.textContent).not.toContain(t('error.30203'));
  client.clear();
});

it('[AC-F1-04b-UNIT#13] 30206 置灰后页面一直开着，到上海次日 0 点自动解除', async () => {
  vi.setSystemTime(new Date('2026-10-22T23:58:00+08:00'));
  const client = createQueryClient();
  const { bridge } = fakeBridge(30206);
  const view = mount(client, bridge);
  await submit();
  expect(button().disabled).toBe(true);
  expect(view.container.textContent).toContain(t('error.30206'));
  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(button().disabled).toBe(true);
  await act(async () => {
    vi.advanceTimersByTime(2 * 60_000);
  });
  expect(button().disabled).toBe(false);
  expect(view.container.textContent).not.toContain(t('error.30206'));
  client.clear();
});

it('[AC-F1-04b-UNIT#14] 置灰按 QueryClient 隔离：另一个壳层缓存不受影响', async () => {
  vi.setSystemTime(new Date('2026-10-22T10:00:00+08:00'));
  const client = createQueryClient();
  const { bridge } = fakeBridge(30203, { reason: 'RISK_BLOCKED' });
  const first = mount(client, bridge);
  await submit();
  expect(button().disabled).toBe(true);
  expect(first.container.textContent).toContain(t('error.30203.RISK_BLOCKED'));
  first.unmount();
  const other = createQueryClient();
  mount(other, bridge);
  expect(button().disabled).toBe(false);
  client.clear();
  other.clear();
});
