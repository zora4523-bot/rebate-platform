// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Skeleton, Toast } from '../../../../apps/h5/src/components/base/index.ts';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.replaceChildren();
});

it('[AC-F1-01f-SKELETON#1] 骨架有 busy 外层、隐藏的色块，并保留调用方尺寸', () => {
  const view = render(createElement(Skeleton, { width: '75%', height: 32 }));
  const busy = view.container.querySelector('[aria-busy="true"]');
  const block = busy?.querySelector<HTMLElement>('[data-slot="skeleton-block"]');
  expect(busy).not.toBeNull();
  expect(block).toBeTruthy();
  expect(block?.getAttribute('aria-hidden')).toBe('true');
  expect(block?.style.width).toBe('75%');
  expect(block?.style.height).toBe('32px');
  expect(view.container.textContent).toBe('');
  expect(screen.queryByRole('button')).toBeNull();
  view.rerender(createElement(Skeleton, { width: 120, height: '2rem' }));
  const updated = view.container.querySelector<HTMLElement>('[data-slot="skeleton-block"]');
  expect(updated?.style.width).toBe('120px');
  expect(updated?.style.height).toBe('2rem');
});

it('[AC-F1-01f-TOAST#1] Toast 礼貌播报调用方文案且不抢焦点，默认 2000ms 消失', () => {
  vi.useFakeTimers();
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  render(createElement(Toast, { message: 'Saved by caller' }));
  const status = screen.getByRole('status');
  expect(status.getAttribute('aria-live')).toBe('polite');
  expect(status.textContent).toBe('Saved by caller');
  expect(document.activeElement).toBe(opener);
  act(() => vi.advanceTimersByTime(1999));
  expect(screen.queryByRole('status')).not.toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByRole('status')).toBeNull();
  expect(document.body.textContent).not.toContain('Saved by caller');
  expect(document.activeElement).toBe(opener);
});

it('[AC-F1-01f-TOAST#2] Toast 使用指定时长而非固定默认值', () => {
  vi.useFakeTimers();
  render(createElement(Toast, { message: '调用方提示', durationMs: 3500 }));
  act(() => vi.advanceTimersByTime(2000));
  expect(screen.getByRole('status').textContent).toBe('调用方提示');
  act(() => vi.advanceTimersByTime(1499));
  expect(screen.queryByRole('status')).not.toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByRole('status')).toBeNull();
});

it('[AC-F1-01f-TOAST#3] 卸载清理定时器，重新挂载获得独立时长', () => {
  vi.useFakeTimers();
  const baseline = vi.getTimerCount();
  const first = render(createElement(Toast, { message: 'First' }));
  act(() => vi.advanceTimersByTime(1000));
  first.unmount();
  expect(vi.getTimerCount()).toBe(baseline);
  render(createElement(Toast, { message: 'Second' }));
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByRole('status').textContent).toBe('Second');
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByRole('status')).toBeNull();
});
