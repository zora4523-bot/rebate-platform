import { createElement } from 'react';
import { act, cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { LedgerPage } from '../../../../apps/h5/src/entries/app/pages/ledger/index.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import type { H5ApiClient } from '../../../../apps/h5/src/shared/api/index.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import { MemoryRouter } from '../../../../apps/h5/src/entries/app/pages/help/router.ts';
export { entry } from '../h5-help/helpers.ts';
export { LOADING } from '../h5-notices/helpers.ts';

configure({ asyncUtilTimeout: 10_000 });
const clients: ReturnType<typeof createQueryClient>[] = [];
const observers = new Set<LedgerIntersectionObserver>();
const scrollProperties = new Map<HTMLElement, Map<string, PropertyDescriptor | undefined>>();

beforeEach(() => {
  // BR-TEXT-11：固定上海当前日期，只替换 Date，异步请求和交互仍走真实计时器。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T12:00:00+08:00'));
});

class LedgerIntersectionObserver implements IntersectionObserver {
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
  vi.stubGlobal('IntersectionObserver', LedgerIntersectionObserver);
  const client = createQueryClient();
  clients.push(client);
  return render(
    createQueryProvider(
      createElement(
        ApiProvider,
        { api },
        createElement(MemoryRouter, { initialEntries: ['/ledger'] }, createElement(LedgerPage, {})),
      ),
      client,
    ),
  );
}

/** Match the smallest rendered text node; each test supplies its required money format. */
export function amount(pattern: RegExp): HTMLElement {
  return screen.getByText(
    (_text, element) =>
      element !== null &&
      pattern.test(element.textContent ?? '') &&
      !Array.from(element.children).some((child) => pattern.test(child.textContent ?? '')),
  );
}

export function rowFor(element: HTMLElement): HTMLElement {
  const row = element.closest('li, [role="listitem"], [role="row"], a, button, [aria-label]');
  expect(row, '流水行须有可访问语义').not.toBeNull();
  return row as HTMLElement;
}

/** Exercise native touch bubbling; no production callback or state is invoked directly. */
export function pullDown(target: HTMLElement): void {
  act(() => {
    // A refresh gesture starts at the top, including after the test paged at the bottom.
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

export function expectQuery(request: Request, cursor?: string): void {
  const url = new URL(request.url);
  expect(request.method).toBe('GET');
  expect(url.pathname).toBe('/v1/wallet/ledger');
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
