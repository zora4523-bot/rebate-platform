import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stepUpTexts } from '../../texts/step-up.ts';
import { StepUpModal } from './StepUpModal.tsx';
import type { StepUpModalProps, StepUpResult } from './types.ts';

// antd Modal 在 jsdom 下注入样式后 getComputedStyle 变慢，单条可能超过默认 5 秒；
// 与 test 包 F1-06za 一致放宽到 15 秒（apps/admin 的 vitest 配置是保护路径，不在此改）。
vi.setConfig({ testTimeout: 15_000 });

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

function resendButton(): HTMLButtonElement {
  return screen.getByRole<HTMLButtonElement>('button', {
    name: (name) => name.startsWith(stepUpTexts.resend),
  });
}

function smsProps(overrides: Partial<StepUpModalProps> = {}): StepUpModalProps {
  return props({
    tier: 'sms',
    maskedPhone: '1',
    onResend: async () => ({ ok: true }),
    ...overrides,
  });
}

it('sms: 42901 on resend without Retry-After waits 5 seconds, not 60', async () => {
  const onResend = vi.fn(async (): Promise<StepUpResult> => ({ ok: false, code: 42901 }));
  render(<StepUpModal {...smsProps({ onResend })} />);
  await advance(60);
  expect(resendButton().disabled).toBe(false);
  await act(async () => {
    fireEvent.click(resendButton());
  });
  expect(onResend).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('alert').textContent).toContain(stepUpTexts.errors.frequent);
  expect(resendButton().textContent).toBe(stepUpTexts.resendCountdown(5));
  await advance(4);
  expect(resendButton().disabled).toBe(true);
  await advance(1);
  expect(resendButton().disabled).toBe(false);
});

it('sms: a 20003 for a code replaced by a resend meanwhile keeps the new countdown', async () => {
  const pending = deferred();
  render(<StepUpModal {...smsProps({ onSubmit: () => pending.promise })} />);
  await advance(60);
  fireEvent.change(input(), { target: { value: '123456' } });
  await act(async () => {
    fireEvent.click(submit());
  });
  await act(async () => {
    fireEvent.click(resendButton());
  });
  expect(resendButton().textContent).toBe(stepUpTexts.resendCountdown(60));
  await act(async () => {
    pending.resolve({ ok: false, code: 20003 });
  });
  expect(screen.getByRole('alert').textContent).toContain(stepUpTexts.errors.generic);
  expect(screen.getByRole('alert').textContent).not.toContain(stepUpTexts.errors.expired);
  expect(resendButton().disabled).toBe(true);
  expect(resendButton().textContent).toBe(stepUpTexts.resendCountdown(60));
});

it('sms: a 20003 for the current code expires it and enables resend at once', async () => {
  render(<StepUpModal {...smsProps({ onSubmit: async () => ({ ok: false, code: 20003 }) })} />);
  fireEvent.change(input(), { target: { value: '123456' } });
  await act(async () => {
    fireEvent.click(submit());
  });
  expect(screen.getByRole('alert').textContent).toContain(stepUpTexts.errors.expired);
  expect(resendButton().disabled).toBe(false);
});

/** Injected monotonic clock that also follows the fake timers; `jump` moves it without timers. */
function manualClock(): { clock: () => number; jump(ms: number): void } {
  let offset = 0;
  return { clock: () => performance.now() + offset, jump: (ms) => (offset += ms) };
}

it('recomputes the resend countdown from its deadline after the machine sleeps', async () => {
  const time = manualClock();
  render(<StepUpModal {...smsProps({ clock: time.clock })} />);
  await advance(10);
  expect(resendButton().textContent).toBe(stepUpTexts.resendCountdown(50));
  // Monotonic time moves 30 s while no timer fires (sleep / throttled tab).
  time.jump(30_000);
  await advance(1);
  expect(resendButton().textContent).toBe(stepUpTexts.resendCountdown(19));
  time.jump(60_000);
  await advance(1);
  expect(resendButton().disabled).toBe(false);
});

it('recomputes the 42901 submit lock from its deadline after the machine sleeps', async () => {
  const time = manualClock();
  const onSubmit = vi.fn(async (): Promise<StepUpResult> => ({
    ok: false,
    code: 42901,
    retryAfterSeconds: 30,
  }));
  render(<StepUpModal {...props({ onSubmit, clock: time.clock })} />);
  fireEvent.change(input(), { target: { value: '123456' } });
  await act(async () => {
    fireEvent.click(submit());
  });
  expect(submit().disabled).toBe(true);
  time.jump(29_500);
  await advance(1);
  expect(submit().disabled).toBe(false);
});

it('a forward wall-clock adjustment unlocks neither the resend countdown nor the submit lock', async () => {
  const onSubmit = vi.fn(async (): Promise<StepUpResult> => ({
    ok: false,
    code: 42901,
    retryAfterSeconds: 30,
  }));
  render(<StepUpModal {...smsProps({ onSubmit })} />);
  await advance(40);
  fireEvent.change(input(), { target: { value: '123456' } });
  await act(async () => {
    fireEvent.click(submit());
  });
  expect(submit().disabled).toBe(true);
  expect(resendButton().textContent).toBe(stepUpTexts.resendCountdown(30));
  // System time is corrected forward by an hour; performance.now() is unaffected.
  vi.setSystemTime(Date.now() + 3_600_000);
  await advance(1);
  expect(submit().disabled).toBe(true);
  expect(resendButton().disabled).toBe(true);
  expect(resendButton().textContent).toBe(stepUpTexts.resendCountdown(29));
  await advance(29);
  expect(submit().disabled).toBe(false);
  expect(resendButton().disabled).toBe(false);
});

it('sms: a late 20003 does not shorten a 42901 resend throttle that started meanwhile', async () => {
  const pending = deferred();
  const onResend = vi.fn(async (): Promise<StepUpResult> => ({
    ok: false,
    code: 42901,
    retryAfterSeconds: 30,
  }));
  render(<StepUpModal {...smsProps({ onSubmit: () => pending.promise, onResend })} />);
  await advance(60);
  fireEvent.change(input(), { target: { value: '123456' } });
  await act(async () => {
    fireEvent.click(submit());
  });
  await act(async () => {
    fireEvent.click(resendButton());
  });
  expect(onResend).toHaveBeenCalledTimes(1);
  expect(resendButton().textContent).toBe(stepUpTexts.resendCountdown(30));
  await advance(5);
  await act(async () => {
    pending.resolve({ ok: false, code: 20003 });
  });
  expect(screen.getByRole('alert').textContent).toContain(stepUpTexts.errors.expired);
  expect(resendButton().disabled).toBe(true);
  expect(resendButton().textContent).toBe(stepUpTexts.resendCountdown(25));
  await advance(24);
  expect(resendButton().disabled).toBe(true);
  await advance(1);
  expect(resendButton().disabled).toBe(false);
});

it('sms: a late 42901 with a shorter Retry-After does not shorten an active resend throttle', async () => {
  const pending = deferred();
  const onResend = vi.fn(async (): Promise<StepUpResult> => ({
    ok: false,
    code: 42901,
    retryAfterSeconds: 30,
  }));
  render(<StepUpModal {...smsProps({ onSubmit: () => pending.promise, onResend })} />);
  await advance(60);
  fireEvent.change(input(), { target: { value: '123456' } });
  await act(async () => {
    fireEvent.click(submit());
  });
  await act(async () => {
    fireEvent.click(resendButton());
  });
  expect(resendButton().textContent).toBe(stepUpTexts.resendCountdown(30));
  await act(async () => {
    pending.resolve({ ok: false, code: 42901, retryAfterSeconds: 3 });
  });
  expect(resendButton().textContent).toBe(stepUpTexts.resendCountdown(30));
  await advance(3);
  expect(submit().disabled).toBe(false);
  expect(resendButton().disabled).toBe(true);
  expect(resendButton().textContent).toBe(stepUpTexts.resendCountdown(27));
});
