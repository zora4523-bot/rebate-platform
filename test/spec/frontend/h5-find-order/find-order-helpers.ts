import { createElement } from 'react';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { MemoryRouter } from '../../../../apps/h5/src/entries/app/pages/help/router.ts';
import { FindOrderPage } from '../../../../apps/h5/src/entries/app/pages/find-order/index.ts';
import { ApiProvider } from '../../../../apps/h5/src/shared/api/app-api.ts';
import { createQueryClient, createQueryProvider } from '../../../../apps/h5/src/shared/query.ts';
import { fixture, NOW, ORDER_NO, PAID_DATE, texts } from './find-order-fixtures.ts';

configure({ asyncUtilTimeout: 10_000 });
const clients: ReturnType<typeof createQueryClient>[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

export function mount(f = fixture()) {
  const client = createQueryClient();
  clients.push(client);
  const view = render(
    createQueryProvider(
      createElement(
        ApiProvider,
        { api: f.api },
        createElement(
          MemoryRouter,
          { initialEntries: ['/find-order'] },
          createElement(FindOrderPage, { bridge: f.bridge }),
        ),
      ),
      client,
    ),
  );
  return { ...view, ...f };
}

export function control(name: string | RegExp): HTMLElement {
  const candidates = ['button', 'link', 'tab', 'radio'].flatMap((role) =>
    screen.queryAllByRole(role, { name }),
  );
  expect(candidates, `唯一入口 ${String(name)}`).toHaveLength(1);
  return candidates[0]!;
}

export function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /提交找回|^提交$/ });
}

export function orderInput(): HTMLInputElement {
  return screen.getByLabelText(/^订单号/);
}
export function dateInput(): HTMLInputElement {
  return screen.getByLabelText(/^付款日期/);
}

export async function ready(): Promise<void> {
  await screen.findByText(texts['claim.guide.paid_date'], { exact: false });
}

export async function fill(order = ORDER_NO, date = PAID_DATE): Promise<void> {
  await ready();
  fireEvent.change(orderInput(), { target: { value: order } });
  fireEvent.change(dateInput(), { target: { value: date } });
}

export async function submit(): Promise<void> {
  await fill();
  await userEvent.setup().click(submitButton());
}

export async function records(): Promise<void> {
  await ready();
  await userEvent.setup().click(control('找回记录'));
}

export function isSelected(element: HTMLElement): boolean {
  return (
    (element instanceof HTMLInputElement && element.type === 'radio' && element.checked) ||
    ['aria-selected', 'aria-checked', 'aria-pressed'].some(
      (name) => element.getAttribute(name) === 'true',
    )
  );
}

export function associatedText(input: HTMLElement): string {
  const ids =
    `${input.getAttribute('aria-describedby') ?? ''} ${input.getAttribute('aria-errormessage') ?? ''}`
      .trim()
      .split(/\s+/);
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
}

export async function fieldError(
  code: number,
  data: unknown,
  key: keyof typeof texts,
  field: 'order' | 'date' = 'order',
) {
  const { result } = await import('./find-order-fixtures.ts');
  const view = mount(fixture({ signed: () => result(code, data) }));
  await submit();
  await screen.findByText(texts[key], { exact: false });
  const input = field === 'date' ? dateInput() : orderInput();
  expect(associatedText(input)).toContain(texts[key]);
  const error =
    `${input.getAttribute('aria-describedby') ?? ''} ${input.getAttribute('aria-errormessage') ?? ''}`
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .find((element) => element?.textContent?.includes(texts[key]));
  expect(error, '字段错误须有独立的关联节点').toBeTruthy();
  expect(input.compareDocumentPosition(error!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(associatedText(field === 'date' ? orderInput() : dateInput())).not.toContain(texts[key]);
  expect(view.container.textContent).not.toContain('PRIVATE');
  expect(view.signedRequests).toHaveLength(1);
  return view;
}

/** Find the smallest record container holding both order number and expected label. */
export function row(order: string, label: string): HTMLElement {
  const number = screen.getByText(
    (_, element) =>
      element?.children.length === 0 && (element.textContent?.includes(order) ?? false),
  );
  let candidate: HTMLElement | null = number;
  while (candidate !== null && !candidate.textContent?.includes(label))
    candidate = candidate.parentElement;
  expect(candidate, `订单 ${order} 必须与 ${label} 同行`).not.toBeNull();
  expect(candidate).not.toBe(document.body);
  return candidate!;
}

export async function expectLocated(order: string, label: string): Promise<void> {
  await screen.findByText(new RegExp(order));
  expect(isSelected(control('找回记录'))).toBe(true);
  await waitFor(() => {
    const record = row(order, label);
    const focused =
      document.activeElement !== document.body && record.contains(document.activeElement);
    const scrolled = vi
      .mocked(HTMLElement.prototype.scrollIntoView)
      .mock.contexts.some(
        (element) => element instanceof Node && (record === element || record.contains(element)),
      );
    expect(focused || scrolled, '目标申请须被聚焦或滚动定位').toBe(true);
  });
}
