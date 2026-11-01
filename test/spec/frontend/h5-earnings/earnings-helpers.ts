import { createElement } from 'react';
import { act, cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { EarningsPage } from '../../../../apps/h5/src/entries/app/pages/earnings/index.ts';
import { MemoryRouter } from '../../../../apps/h5/src/entries/app/pages/help/router.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import type { H5ApiClient } from '../../../../apps/h5/src/shared/api/index.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import { copy, NOW, SECTIONS, SUMMARY_PATH } from './earnings-fixtures.ts';
export { LOADING } from '../h5-notices/helpers.ts';

configure({ asyncUtilTimeout: 10_000 });
const clients: ReturnType<typeof createQueryClient>[] = [];

beforeEach(() => {
  // BR-TEXT-11：固定上海当前时刻，只替换 Date，异步请求和交互仍走真实计时器。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

export function mount(api: H5ApiClient | null) {
  const client = createQueryClient();
  clients.push(client);
  return render(
    createQueryProvider(
      createElement(
        ApiProvider,
        { api },
        createElement(
          MemoryRouter,
          { initialEntries: ['/earnings'] },
          createElement(EarningsPage, {}),
        ),
      ),
      client,
    ),
  );
}

export function squash(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Accessible name that is exactly `text` (surrounding whitespace allowed). */
export function exactName(text: string): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`);
}

/** Accessible name that contains `text`. */
export function containsName(text: string): RegExp {
  return new RegExp(escapeRegExp(text));
}

/** Controls a segmented control or a filter pill may be: button, tab, radio. */
export function controls(name: string | RegExp): HTMLElement[] {
  return ['button', 'tab', 'radio'].flatMap((role) => screen.queryAllByRole(role, { name }));
}

/** The single period option or platform pill whose accessible name is exactly `label`. */
export function control(label: string): HTMLElement {
  const found = controls(exactName(label));
  expect(found, `唯一可访问控件「${label}」`).toHaveLength(1);
  return found[0]!;
}

/** Selection is announced (筛选项播报选中, 规格 §6): checked radio or aria-selected/checked/pressed. */
export function isSelected(element: HTMLElement): boolean {
  return (
    (element instanceof HTMLInputElement && element.type === 'radio' && element.checked) ||
    ['aria-selected', 'aria-checked', 'aria-pressed'].some(
      (name) => element.getAttribute(name) === 'true',
    )
  );
}

/** Deepest elements in `root` whose whole text is `text`, outside buttons and dialogs. */
function labels(root: HTMLElement, text: string): HTMLElement[] {
  const wanted = squash(text);
  const all = Array.from(root.querySelectorAll<HTMLElement>('*')).filter(
    (element) =>
      squash(element.textContent) === wanted &&
      element.closest('button, [role="dialog"], [role="tab"], [role="radio"]') === null,
  );
  return all.filter(
    (element) => !all.some((other) => other !== element && element.contains(other)),
  );
}

/**
 * One column card (规格 §2): found by its title (an element whose whole text is the title), then
 * going up to the smallest ancestor that also holds the 已结算 metric. The card must not hold
 * another column's title, so each column is its own group.
 */
export function section(title: string): HTMLElement {
  const headings = labels(document.body, title);
  expect(headings, `栏标题「${title}」只出现一次`).toHaveLength(1);
  let card: HTMLElement | null = headings[0]!.parentElement;
  while (card !== null && !squash(card.textContent).includes(squash(copy.credited)))
    card = card.parentElement;
  expect(card, `「${title}」栏含「${copy.credited}」指标`).not.toBeNull();
  for (const other of SECTIONS) {
    if (other === title) continue;
    expect(labels(card!, other), `「${title}」栏不含「${other}」栏`).toEqual([]);
  }
  return card!;
}

/** Whether a column title is rendered anywhere on the page. */
export function hasSection(title: string): boolean {
  return labels(document.body, title).length > 0;
}

const MONEY = /[+−-]?[¥￥]\d+(?:\.\d+)?/g;

/** Money tokens in an element's text (whitespace removed), in order. */
export function money(element: HTMLElement): string[] {
  return squash(element.textContent).match(MONEY) ?? [];
}

/** Digit runs in an element's text once money tokens are removed. */
export function numbers(element: HTMLElement): string[] {
  return squash(element.textContent).replace(MONEY, '').match(/\d+/g) ?? [];
}

/**
 * The smallest container in a column that holds one metric's name and its value (label and value
 * read together); it must not hold another metric of the same column.
 */
export function metric(card: HTMLElement, name: string, others: readonly string[]): HTMLElement {
  const found = labels(card, name);
  expect(found, `「${name}」在栏内只出现一次`).toHaveLength(1);
  let cell: HTMLElement | null = found[0]!.parentElement;
  while (cell !== null && card.contains(cell) && !/\d/.test(squash(cell.textContent)))
    cell = cell.parentElement;
  expect(cell !== null && card.contains(cell), `「${name}」旁有数值`).toBe(true);
  for (const other of others) {
    if (other === name) continue;
    expect(labels(cell!, other), `「${name}」与「${other}」各自成组`).toEqual([]);
  }
  return cell!;
}

const SELF_METRICS = [copy.paidCount, copy.estSelf, copy.credited] as const;
const SHARE_METRICS = [copy.paidCount, copy.estPromo, copy.credited] as const;

/** paid_count / est / credited as shown in the self or share column. */
export function columnValues(title: string): {
  count: string[];
  est: string[];
  credited: string[];
} {
  const card = section(title);
  const names = title === copy.self ? SELF_METRICS : SHARE_METRICS;
  return {
    count: numbers(metric(card, names[0], names)),
    est: money(metric(card, names[1], names)),
    credited: money(metric(card, names[2], names)),
  };
}

/** Wait until the dashboard figures are on screen. */
export async function ready(): Promise<void> {
  await screen.findAllByText(copy.self);
  await act(async () => {});
}

/** Page text with whitespace removed. */
export function pageText(container: HTMLElement): string {
  return squash(container.textContent);
}

/** Exercise native touch bubbling from the top of the page; no production callback is invoked. */
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

/** GET /v1/earnings/summary with no query other than an optional platform. */
export function expectQuery(request: Request, platform?: string): void {
  const url = new URL(request.url);
  expect(request.method).toBe('GET');
  expect(url.pathname).toBe(SUMMARY_PATH);
  expect([...url.searchParams.keys()].filter((key) => key !== 'platform')).toEqual([]);
  expect(url.searchParams.getAll('platform')).toEqual(platform === undefined ? [] : [platform]);
}
