import { configure, within } from '@testing-library/react';
import { expect } from 'vitest';
import { mainElement } from '../admin-users/helpers.ts';

export * from '../admin-users/helpers.ts';
configure({ asyncUtilTimeout: 10_000 });

// Missing visual elements must fail an assertion, never a query exception / null dereference.
export function required<T>(value: T | null | undefined, message: string): T {
  expect(value, message).not.toBeNull();
  expect(value, message).not.toBeUndefined();
  return value!;
}

export function card(title: string): HTMLElement {
  const label = required(
    within(mainElement()).queryByText(title, { exact: true }),
    `card title: ${title}`,
  );
  return required(label.closest<HTMLElement>('.ant-card'), `antd Card: ${title}`);
}

export function detailHeader(): HTMLElement {
  const heading = required(
    within(mainElement()).queryByRole('heading', { name: '用户详情' }),
    '用户详情 heading',
  );
  let header = heading.parentElement;
  while (
    header &&
    header !== mainElement() &&
    !within(header).queryByRole('button', { name: '返回用户查询' })
  )
    header = header.parentElement;
  const found = required(header, 'title row with return action');
  expect(found, 'header must not encompass the detail cards').not.toBe(mainElement());
  expect(within(found).queryByText('基本信息', { exact: true })).toBeNull();
  return found;
}

export function expectMonospace(node: HTMLElement): void {
  let current: HTMLElement | null = node;
  const families: string[] = [];
  while (current && current !== mainElement()) {
    families.push(getComputedStyle(current).fontFamily);
    current = current.parentElement;
  }
  expect(families.join(' '), 'UID uses a monospace font').toMatch(/monospace/i);
}

export function appliedBar(): HTMLElement {
  const tag = required(
    within(mainElement()).queryByText('已应用', { exact: true }),
    'applied filter Tag',
  );
  expect(tag.closest('.ant-tag'), '已应用 is an antd Tag').not.toBeNull();
  const summary = required(
    tag.closest<HTMLElement>('[aria-live="polite"]'),
    'polite applied summary',
  );
  expect(within(summary).queryAllByRole('table', { hidden: true })).toHaveLength(0);
  expect(summary.querySelector('.ant-pagination'), 'summary must exclude pagination').toBeNull();
  return summary;
}
