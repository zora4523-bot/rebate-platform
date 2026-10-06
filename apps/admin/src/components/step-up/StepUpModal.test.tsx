import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stepUpTexts } from '../../texts/step-up.ts';
import { StepUpModal } from './StepUpModal.tsx';
import type { StepUpModalProps, StepUpResult } from './types.ts';

function props(overrides: Partial<StepUpModalProps> = {}): StepUpModalProps {
  return {
    open: true,
    tier: 'totp',
    operation: 'operation',
    onSubmit: async () => ({ ok: true, stepUpToken: 'token' }),
    onClose: () => {},
    onVerified: () => {},
    ...overrides,
  };
}

function input(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('textbox');
}

function submit(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', { name: stepUpTexts.submit });
}

function deferred(): { promise: Promise<StepUpResult>; resolve(result: StepUpResult): void } {
  let resolve!: (result: StepUpResult) => void;
  const promise = new Promise<StepUpResult>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function advance(seconds: number): Promise<void> {
  for (let index = 0; index < seconds; index += 1) {
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.replaceChildren();
});

for (const tier of ['totp', 'sms'] as const) {
  for (const [retryAfterSeconds, seconds] of [
    [3, 3],
    [undefined, 5],
  ] as const) {
    it(`${tier}: 42901 on submit locks button and Enter for ${seconds}s`, async () => {
      const failure: StepUpResult =
        retryAfterSeconds === undefined
          ? { ok: false, code: 42901 }
          : { ok: false, code: 42901, retryAfterSeconds };
      const onSubmit = vi.fn(async (): Promise<StepUpResult> => failure);
      render(<StepUpModal {...props({ tier, maskedPhone: '1', onSubmit, onResend: vi.fn() })} />);
      fireEvent.change(input(), { target: { value: '123456' } });
      await act(async () => {
        fireEvent.click(submit());
      });
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('alert').textContent).toContain(stepUpTexts.errors.frequent);
      expect(submit().disabled).toBe(true);
      await act(async () => {
        fireEvent.keyDown(input(), { key: 'Enter', code: 'Enter' });
        fireEvent.click(submit());
      });
      expect(onSubmit).toHaveBeenCalledTimes(1);
      await advance(seconds - 1);
      expect(submit().disabled).toBe(true);
      await advance(1);
      expect(submit().disabled).toBe(false);
      await act(async () => {
        fireEvent.keyDown(input(), { key: 'Enter', code: 'Enter' });
      });
      expect(onSubmit).toHaveBeenCalledTimes(2);
    });
  }
}

for (const dismissal of ['escape', 'cancel', 'close', 'unmount'] as const) {
  it(`drops an in-flight result after ${dismissal}`, async () => {
    const pending = deferred();
    const onVerified = vi.fn();
    const onClose = vi.fn();
    const view = render(
      <StepUpModal {...props({ onSubmit: () => pending.promise, onVerified, onClose })} />,
    );
    fireEvent.change(input(), { target: { value: '123456' } });
    await act(async () => {
      fireEvent.click(submit());
    });
    if (dismissal === 'escape') fireEvent.keyDown(input(), { key: 'Escape' });
    else if (dismissal === 'cancel')
      fireEvent.click(screen.getByRole('button', { name: stepUpTexts.cancel }));
    else if (dismissal === 'close')
      fireEvent.click(screen.getByRole('button', { name: stepUpTexts.close }));
    else view.unmount();
    if (dismissal !== 'unmount') expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ ok: true, stepUpToken: 'late' });
    });
    expect(onVerified).not.toHaveBeenCalled();
  });
}

it('drops a result from a previous opening after reopen', async () => {
  const pending = deferred();
  const onVerified = vi.fn();
  const base = props({ onSubmit: () => pending.promise, onVerified });
  const view = render(<StepUpModal {...base} />);
  fireEvent.change(input(), { target: { value: '123456' } });
  await act(async () => {
    fireEvent.click(submit());
  });
  view.rerender(<StepUpModal {...base} open={false} />);
  view.rerender(<StepUpModal {...base} />);
  await act(async () => {
    pending.resolve({ ok: true, stepUpToken: 'late' });
  });
  expect(onVerified).not.toHaveBeenCalled();
  expect(submit().getAttribute('aria-busy')).toBeNull();
});

for (const result of [{ ok: true }, { ok: true, stepUpToken: '' }] as const) {
  it(`treats success without a token (${JSON.stringify(result)}) as a generic failure`, async () => {
    const onVerified = vi.fn();
    render(<StepUpModal {...props({ onSubmit: async () => result, onVerified })} />);
    fireEvent.change(input(), { target: { value: '123456' } });
    await act(async () => {
      fireEvent.click(submit());
    });
    expect(onVerified).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain(stepUpTexts.errors.generic);
    expect(screen.getByRole('dialog')).toBeDefined();
  });
}

it('isolates every body child under it, restores original values, and keeps Escape from layers below', () => {
  const app = document.createElement('div');
  app.id = 'root';
  const drawer = document.createElement('div');
  drawer.setAttribute('aria-hidden', 'false');
  const hiddenAlready = document.createElement('div');
  hiddenAlready.setAttribute('inert', '');
  document.body.append(app, drawer, hiddenAlready);
  const below = vi.fn();
  document.addEventListener('keydown', below);
  const onClose = vi.fn();
  const view = render(<StepUpModal {...props({ onClose })} />);
  for (const element of [app, drawer, hiddenAlready]) {
    expect(element.hasAttribute('inert')).toBe(true);
    expect(element.getAttribute('aria-hidden')).toBe('true');
  }
  expect(view.container.hasAttribute('inert')).toBe(true);
  expect(screen.getByRole('dialog').closest('[inert], [aria-hidden="true"]')).toBeNull();
  fireEvent.keyDown(input(), { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(below).not.toHaveBeenCalled();
  view.rerender(<StepUpModal {...props({ onClose })} open={false} />);
  expect(app.hasAttribute('inert')).toBe(false);
  expect(app.hasAttribute('aria-hidden')).toBe(false);
  expect(drawer.hasAttribute('inert')).toBe(false);
  expect(drawer.getAttribute('aria-hidden')).toBe('false');
  expect(hiddenAlready.hasAttribute('inert')).toBe(true);
  expect(hiddenAlready.hasAttribute('aria-hidden')).toBe(false);
  document.removeEventListener('keydown', below);
});
