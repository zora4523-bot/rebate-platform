// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { EmptyState, ErrorState } from '../../../../apps/h5/src/components/base/index.ts';

afterEach(cleanup);

for (const Component of [EmptyState, ErrorState]) {
  const name = Component.name;

  it(`[AC-F1-01f-STATE#1] ${name} 透传标题、辅助文案、装饰图标与操作`, async () => {
    const onClick = vi.fn();
    const view = render(
      createElement(Component, {
        title: 'Nothing here yet',
        description: 'Choose another filter',
        icon: createElement('svg', { 'data-testid': 'caller-icon' }),
        action: { label: 'Try again', onClick },
      }),
    );
    const heading = screen.getByRole('heading', { name: 'Nothing here yet' });
    const description = screen.getByText('Choose another filter');
    const button = screen.getByRole('button', { name: 'Try again' });
    const illustration = view.container.querySelector('[data-slot="state-illustration"]');
    expect(illustration).not.toBeNull();
    expect(illustration?.contains(screen.getByTestId('caller-icon'))).toBe(true);
    expect(illustration?.getAttribute('aria-hidden')).toBe('true');
    expect(
      heading.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(description.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
    expect(view.container.textContent).toBe('Nothing here yetChoose another filterTry again');
    await userEvent.setup().click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it(`[AC-F1-01f-STATE#2] ${name} 操作可省略，不内置兜底文案或按钮`, () => {
    const view = render(
      createElement(Component, {
        title: '调用方标题',
        description: '调用方辅助说明',
        icon: null,
      }),
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(view.container.textContent).toBe('调用方标题调用方辅助说明');
    if (Component === ErrorState) {
      expect(within(screen.getByRole('alert')).getByText('调用方标题')).toBeTruthy();
    } else {
      expect(screen.queryByRole('alert')).toBeNull();
    }
  });
}
