// @vitest-environment jsdom
import { createElement, type ComponentType } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Toast } from '../../../../apps/h5/src/components/base/index.ts';

const CompatibleToast = Toast as unknown as ComponentType<Record<string, unknown>>;
const regionSelector = '[data-slot="toast-region"]';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function regionIn(container: HTMLElement): HTMLElement {
  const regions = container.querySelectorAll<HTMLElement>(regionSelector);
  expect(regions).toHaveLength(1);
  return regions[0]!;
}

async function expectMessage(region: HTMLElement, message: string): Promise<void> {
  await waitFor(() => {
    expect(region.querySelector('[role="status"]')?.textContent).toBe(message);
  });
  expect(region.getAttribute('aria-live')).toBe('polite');
  expect(region.hasAttribute('role')).toBe(false);
  expect(region.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
}

it('[AC-F1-01o-TOAST#1] 默认 portal 到 body，提示和常驻播报区均在 inert 调用容器之外', async () => {
  const caller = document.createElement('main');
  caller.setAttribute('inert', '');
  document.body.append(caller);
  const view = render(createElement(Toast, { message: '复制成功' }), { container: caller });
  expect(view.container.textContent).not.toContain('复制成功');
  const region = regionIn(document.body);
  expect(caller.contains(region)).toBe(false);
  expect(region.closest('[inert]')).toBeNull();
  await expectMessage(region, '复制成功');
  expect(caller.querySelector('[role="status"]')).toBeNull();
  view.unmount();
  expect(regionIn(document.body)).toBe(region);
  expect(region.textContent).toBe('');
  expect(screen.queryByRole('status')).toBeNull();
});

it('[AC-F1-01o-TOAST#2] 自定义挂载点保留同一播报区，卸载后相同消息重新播报', async () => {
  const target = document.createElement('aside');
  document.body.append(target);
  const first = render(createElement(CompatibleToast, { message: '已保存', container: target }));
  const region = regionIn(target);
  expect(first.container.contains(region)).toBe(false);
  expect(first.container.textContent).toBe('');
  await expectMessage(region, '已保存');

  first.unmount();
  expect(regionIn(target)).toBe(region);
  expect(region.textContent).toBe('');
  expect(region.querySelector('[role="status"]')).toBeNull();
  const second = render(createElement(CompatibleToast, { message: '已保存', container: target }));
  expect(regionIn(target)).toBe(region);
  await expectMessage(region, '已保存');
  expect(second.container.textContent).toBe('');
  second.unmount();
  expect(regionIn(target)).toBe(region);
  expect(region.textContent).toBe('');
});

it('[AC-F1-01o-TOAST#3] 文案改变、到时清空及同文新挂载均复用常驻播报区', async () => {
  vi.useFakeTimers();
  const view = render(createElement(Toast, { message: '第一条' }));
  const region = regionIn(document.body);
  // Flush a deferred task/frame without consuming the notice's lifetime.
  await act(async () => vi.advanceTimersByTimeAsync(50));
  expect(region.querySelector('[role="status"]')?.textContent).toBe('第一条');
  view.rerender(createElement(Toast, { message: '第二条' }));
  await act(async () => vi.advanceTimersByTimeAsync(50));
  expect(regionIn(document.body)).toBe(region);
  expect(region.querySelector('[role="status"]')?.textContent).toBe('第二条');
  act(() => vi.advanceTimersByTime(2000));
  expect(regionIn(document.body)).toBe(region);
  expect(region.textContent).toBe('');
  expect(screen.queryByRole('status')).toBeNull();
  view.unmount();
  expect(regionIn(document.body)).toBe(region);

  render(createElement(Toast, { message: '第二条' }));
  await act(async () => vi.advanceTimersByTimeAsync(50));
  expect(regionIn(document.body)).toBe(region);
  expect(region.querySelector('[role="status"]')?.textContent).toBe('第二条');
});
