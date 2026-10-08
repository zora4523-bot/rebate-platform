// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  EmptyState,
  ErrorState,
  type StateProps,
} from '../../../../apps/h5/src/components/base/index.ts';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// AC-F1-01o identifiers refer to task §2; no business AC was assigned.
it('[AC-F1-01o-FOCUS#1] 仅显式启用且有 action 的 ErrorState 将焦点移到重试按钮', async () => {
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  const onClick = vi.fn();
  const props: StateProps = {
    title: '加载失败',
    description: '请重试',
    icon: null,
    action: { label: '重试', onClick },
  };

  // Negative controls share this red test: the positive opt-in below fails on the old code.
  for (const options of [{}, { autoFocusAction: false }]) {
    const view = render(createElement(ErrorState, { ...props, ...options }));
    expect(document.activeElement).toBe(opener);
    view.unmount();
  }
  const empty = render(createElement(EmptyState, { ...props, autoFocusAction: true }));
  expect(document.activeElement).toBe(opener);
  empty.unmount();

  const withoutAction = render(
    createElement(ErrorState, {
      title: props.title,
      description: props.description,
      icon: null,
      autoFocusAction: true,
    }),
  );
  expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
  expect(document.activeElement).toBe(opener);
  withoutAction.unmount();

  render(createElement(ErrorState, { ...props, autoFocusAction: true }));
  const action = screen.getByRole('button', { name: '重试' });
  await waitFor(() => expect(document.activeElement).toBe(action));
  expect(screen.getByRole('alert').textContent).toContain(props.title);
  expect(onClick).not.toHaveBeenCalled();
  fireEvent.click(action);
  expect(onClick).toHaveBeenCalledTimes(1);
});
