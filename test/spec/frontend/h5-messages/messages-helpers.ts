import { createElement } from 'react';
import { act, cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { MessagesPage } from '../../../../apps/h5/src/entries/app/pages/messages/index.ts';
import { MemoryRouter } from '../../../../apps/h5/src/entries/app/pages/help/router.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import type { H5ApiClient } from '../../../../apps/h5/src/shared/api/index.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import { texts } from './messages-fixtures.ts';

configure({ asyncUtilTimeout: 10_000 });
const clients: ReturnType<typeof createQueryClient>[] = [];
const observers = new Set<MessagesIntersectionObserver>();
const scrollProperties = new Map<HTMLElement, Map<string, PropertyDescriptor | undefined>>();

export const LOADING = '[aria-busy="true"], [role="status"], [data-slot="skeleton-block"]';
/** 当前时刻（上海）：今天 = 2026-10-22，昨天 = 2026-10-21。 */
export const NOW = '2026-10-22T12:00:00+08:00';

beforeEach(() => {
  // BR-TEXT-11：固定当前时刻，只替换 Date，异步请求和交互仍走真实计时器。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

class MessagesIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];
  readonly targets = new Set<Element>();
  readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.add(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
    observers.delete(this);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  intersect(): void {
    this.callback(
      Array.from(this.targets, (target) => ({
        target,
        isIntersecting: true,
        intersectionRatio: 1,
        time: 0,
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRect: target.getBoundingClientRect(),
        rootBounds: null,
      })),
      this,
    );
  }
}

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  observers.clear();
  for (const [element, properties] of scrollProperties) {
    for (const [name, descriptor] of properties) {
      if (descriptor) Object.defineProperty(element, name, descriptor);
      else Reflect.deleteProperty(element, name);
    }
  }
  scrollProperties.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

export function mount(api: H5ApiClient | null) {
  vi.stubGlobal('IntersectionObserver', MessagesIntersectionObserver);
  const client = createQueryClient();
  clients.push(client);
  return render(
    createQueryProvider(
      createElement(
        ApiProvider,
        { api },
        createElement(
          MemoryRouter,
          { initialEntries: ['/messages'] },
          createElement(MessagesPage, {}),
        ),
      ),
      client,
    ),
  );
}

/** The list item that holds a message, found by its (unique) body text. */
export function rowFor(text: string): HTMLElement {
  const element = screen.getByText(text, { exact: false });
  const row = element.closest('li, [role="listitem"]');
  expect(row, '消息行须是列表项').not.toBeNull();
  return row as HTMLElement;
}

/** The one button or link of a row (the clickable message), matched by accessible name. */
export function entry(name: string | RegExp): HTMLElement {
  const controls = [
    ...screen.queryAllByRole('button', { name }),
    ...screen.queryAllByRole('link', { name }),
  ];
  expect(controls, `唯一可访问入口 ${String(name)}`).toHaveLength(1);
  return controls[0]!;
}

/** Text a screen reader can get from the row: content, labels and referenced descriptions. */
export function spoken(row: HTMLElement): string {
  const parts: string[] = [];
  const hidden = (element: Element | null) =>
    element !== null && element.closest('[aria-hidden="true"], [hidden]') !== null;
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!hidden(node.parentElement)) parts.push(node.textContent ?? '');
  }
  for (const element of [row, ...Array.from(row.querySelectorAll<HTMLElement>('*'))]) {
    if (hidden(element)) continue;
    const label = element.getAttribute('aria-label');
    if (label !== null) parts.push(label);
    for (const reference of ['aria-labelledby', 'aria-describedby']) {
      for (const id of (element.getAttribute(reference) ?? '').split(/\s+/).filter(Boolean)) {
        parts.push(document.getElementById(id)?.textContent ?? '');
      }
    }
  }
  return parts.join(' ');
}

/** Whether the row announces the dictionary word for unread (the dot alone is not read out). */
export function announcesUnread(row: HTMLElement): boolean {
  return spoken(row).includes(texts.unread);
}

/** Row text without whitespace, for format checks such as 「今天09:05」. */
export function compact(element: HTMLElement): string {
  return (element.textContent ?? '').replace(/\s+/g, '');
}

/** Exercise native touch bubbling; no production callback or state is invoked directly. */
export function pullDown(target: HTMLElement): void {
  act(() => {
    for (let element: HTMLElement | null = target; element; element = element.parentElement) {
      element.scrollTop = 0;
    }
    fireEvent.touchStart(target, { touches: [{ identifier: 1, clientX: 100, clientY: 30 }] });
    fireEvent.touchMove(target, { touches: [{ identifier: 1, clientX: 100, clientY: 200 }] });
    fireEvent.touchEnd(target, {
      touches: [],
      changedTouches: [{ identifier: 1, clientX: 100, clientY: 200 }],
    });
  });
}

/** Support either scroll listeners or an IntersectionObserver sentinel at the DOM boundary. */
export function reachBottom(target: HTMLElement): void {
  act(() => {
    for (const observer of observers) observer.intersect();
    for (let element: HTMLElement | null = target; element; element = element.parentElement) {
      if (!scrollProperties.has(element)) {
        scrollProperties.set(
          element,
          new Map(
            ['scrollHeight', 'clientHeight', 'scrollTop'].map((name) => [
              name,
              Object.getOwnPropertyDescriptor(element, name),
            ]),
          ),
        );
      }
      Object.defineProperties(element, {
        scrollHeight: { configurable: true, value: 1200 },
        clientHeight: { configurable: true, value: 600 },
        scrollTop: { configurable: true, value: 600, writable: true },
      });
      fireEvent.scroll(element);
    }
    fireEvent.scroll(window);
  });
}

export function expectListQuery(request: Request, cursor?: string): void {
  const url = new URL(request.url);
  expect(request.method).toBe('GET');
  expect(url.pathname).toBe('/v1/messages');
  expect(url.searchParams.getAll('cursor')).toEqual(cursor === undefined ? [] : [cursor]);
  expect([...url.searchParams.keys()].filter((key) => !['cursor', 'limit'].includes(key))).toEqual(
    [],
  );
  expect(url.searchParams.getAll('limit').length).toBeLessThanOrEqual(1);
  if (url.searchParams.has('limit')) {
    expect(url.searchParams.get('limit')).toMatch(/^\d+$/);
    expect(Number(url.searchParams.get('limit'))).toBeGreaterThanOrEqual(1);
    expect(Number(url.searchParams.get('limit'))).toBeLessThanOrEqual(50);
  }
}

/** Let pending promises and React updates settle without advancing any timer. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
