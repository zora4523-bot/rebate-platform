// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  StepUpModal,
  type StepUpResult,
} from '../../../../apps/admin/src/components/step-up/index.ts';
import { COPY, modalProps } from './fixtures.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function input(): HTMLInputElement {
  return screen.getByRole('textbox') as HTMLInputElement;
}

function submit(): HTMLButtonElement {
  return screen.getByRole('button', { name: '验证并继续' }) as HTMLButtonElement;
}

function resend(): HTMLButtonElement {
  return screen.getByRole('button', { name: /重新发送/ }) as HTMLButtonElement;
}

async function click(button: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(button);
  });
}

async function advance(seconds: number): Promise<void> {
  // Flush each tick so both interval-based and effect-scheduled timers behave like a browser.
  for (let second = 0; second < seconds; second++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }
}

for (const tier of ['totp', 'sms'] as const) {
  it(`[AC-F1-06f-MODAL#1] ${tier} 显示对应标题、输入标签、说明及六位提交门槛`, () => {
    const onSubmit = vi.fn(async (): Promise<StepUpResult> => ({ ok: true }));
    render(createElement(StepUpModal, modalProps({ tier, maskedPhone: '137****3366', onSubmit })));
    expect(screen.getByRole('dialog', { name: COPY[tier].title })).toBeDefined();
    expect(screen.getByRole('textbox', { name: COPY[tier].label })).toBe(input());
    expect(screen.getByText(COPY[tier].hint)).toBeDefined();
    expect(screen.getByText('查看完整手机号')).toBeDefined();
    expect(screen.getByText('对象：用户 U10023 · 本次查看会记入操作日志')).toBeDefined();
    expect(submit().disabled).toBe(true);
    for (const code of ['1', '12345', '']) {
      fireEvent.change(input(), { target: { value: code } });
      expect(submit().disabled).toBe(true);
      fireEvent.click(submit());
      fireEvent.keyDown(input(), { key: 'Enter', code: 'Enter' });
      expect(onSubmit).not.toHaveBeenCalled();
    }
    fireEvent.change(input(), { target: { value: '012345' } });
    expect(submit().disabled).toBe(false);
    if (tier === 'totp') {
      expect(screen.queryByRole('button', { name: /重新发送/ })).toBeNull();
      expect(screen.queryByText(/137\*{4}3366/)).toBeNull();
    } else {
      expect(screen.getByText(/137\*{4}3366/)).toBeDefined();
      expect(screen.getByText(COPY.smsExplanation)).toBeDefined();
    }
  });

  it(`[AC-F1-06f-MODAL#2] ${tier} 提交中不可重复提交，成功仅回调 token 等调用方关闭`, async () => {
    let resolve!: (result: StepUpResult) => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<StepUpResult>((done) => {
          resolve = done;
        }),
    );
    const onVerified = vi.fn();
    const onClose = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const xhr = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    render(
      createElement(
        StepUpModal,
        modalProps({ tier, maskedPhone: '137****3366', onSubmit, onVerified, onClose }),
      ),
    );
    fireEvent.change(input(), { target: { value: '012345' } });
    await click(submit());
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('012345');
    // Accessible busy state is the public loading contract, independent of the icon library.
    expect(submit().getAttribute('aria-busy')).toBe('true');
    await click(submit());
    fireEvent.keyDown(input(), { key: 'Enter', code: 'Enter' });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onVerified).not.toHaveBeenCalled();
    await act(async () => {
      resolve({ ok: true, stepUpToken: `token-${tier}` });
    });
    expect(onVerified).toHaveBeenCalledExactlyOnceWith(`token-${tier}`);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
    expect(storage).not.toHaveBeenCalled();
  });

  it(`[AC-F1-06f-MODAL#3] ${tier} 20002 清空、报错、标 invalid 并还焦点，可重新验证`, async () => {
    const onSubmit = vi.fn(async (): Promise<StepUpResult> => ({ ok: false, code: 20002 }));
    const onVerified = vi.fn();
    render(
      createElement(
        StepUpModal,
        modalProps({ tier, maskedPhone: '137****3366', onSubmit, onVerified }),
      ),
    );
    fireEvent.change(input(), { target: { value: '123456' } });
    submit().focus();
    await click(submit());
    expect(screen.getByRole('alert').textContent).toContain(COPY.incorrect);
    expect(input().value).toBe('');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(input());
    expect(submit().disabled).toBe(true);
    expect(onVerified).not.toHaveBeenCalled();
    onSubmit.mockResolvedValue({ ok: true, stepUpToken: 'corrected-token' });
    fireEvent.change(input(), { target: { value: '654321' } });
    await click(submit());
    expect(onVerified).toHaveBeenCalledExactlyOnceWith('corrected-token');
  });

  it(`[AC-F1-06f-MODAL#4] ${tier} 未知错误显示通用提示并保持打开`, async () => {
    const onClose = vi.fn();
    const onVerified = vi.fn();
    render(
      createElement(
        StepUpModal,
        modalProps({
          tier,
          maskedPhone: '137****3366',
          onSubmit: async () => ({ ok: false, code: 50000 }),
          onClose,
          onVerified,
        }),
      ),
    );
    fireEvent.change(input(), { target: { value: '123456' } });
    await click(submit());
    expect(screen.getByRole('alert').textContent).toContain(COPY.generic);
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
    expect(onVerified).not.toHaveBeenCalled();
    expect(submit().getAttribute('aria-busy')).not.toBe('true');
  });
}

it('[AC-F1-06f-SMS#1] 打开视为已发码，60 秒到零才允许重发，成功后重新计时', async () => {
  const onResend = vi.fn(async (): Promise<StepUpResult> => ({ ok: true }));
  const onVerified = vi.fn();
  render(
    createElement(
      StepUpModal,
      modalProps({ tier: 'sms', maskedPhone: '137****3366', onResend, onVerified }),
    ),
  );
  expect(resend().textContent).toMatch(/60\s*秒/);
  expect(resend().disabled).toBe(true);
  await click(resend());
  expect(onResend).not.toHaveBeenCalled();
  await advance(2);
  expect(resend().textContent).toMatch(/58\s*秒/);
  await advance(57);
  expect(resend().disabled).toBe(true);
  expect(resend().textContent).toMatch(/1\s*秒/);
  await advance(1);
  expect(resend().textContent?.trim()).toBe('重新发送');
  expect(resend().disabled).toBe(false);
  await click(resend());
  expect(onResend).toHaveBeenCalledTimes(1);
  expect(resend().textContent).toMatch(/60\s*秒/);
  expect(resend().disabled).toBe(true);
  expect(onVerified).not.toHaveBeenCalled();
});

it('[AC-F1-06f-SMS#2] 20003 显示失效提示，剩余倒计时立即解除', async () => {
  const onResend = vi.fn(async (): Promise<StepUpResult> => ({ ok: true }));
  render(
    createElement(
      StepUpModal,
      modalProps({
        tier: 'sms',
        maskedPhone: '137****3366',
        onResend,
        onSubmit: async () => ({ ok: false, code: 20003 }),
      }),
    ),
  );
  fireEvent.change(input(), { target: { value: '123456' } });
  await click(submit());
  expect(screen.getByRole('alert').textContent).toContain(COPY.expired);
  expect(resend().disabled).toBe(false);
  await click(resend());
  expect(onResend).toHaveBeenCalledTimes(1);
});

for (const source of ['submit', 'resend'] as const) {
  it(`[AC-F1-06f-SMS#3] ${source} 返回 42901 时按 retryAfterSeconds 重启倒计时`, async () => {
    const result: StepUpResult = { ok: false, code: 42901, retryAfterSeconds: 17 };
    const onResend = vi.fn(async (): Promise<StepUpResult> =>
      source === 'resend' ? result : { ok: true },
    );
    render(
      createElement(
        StepUpModal,
        modalProps({
          tier: 'sms',
          maskedPhone: '137****3366',
          onSubmit: async () => result,
          onResend,
        }),
      ),
    );
    if (source === 'submit') {
      await advance(2);
      fireEvent.change(input(), { target: { value: '123456' } });
      await click(submit());
    } else {
      await advance(60);
      await click(resend());
    }
    expect(screen.getByRole('alert').textContent).toContain(COPY.frequent);
    expect(resend().textContent).toMatch(/17\s*秒/);
    expect(resend().disabled).toBe(true);
    await advance(16);
    expect(resend().disabled).toBe(true);
    expect(resend().textContent).toMatch(/1\s*秒/);
    await advance(1);
    expect(resend().disabled).toBe(false);
    expect(resend().textContent?.trim()).toBe('重新发送');
  });
}

it('[AC-F1-06f-SMS#4] 重新打开从 60 开始且没有上次输入和错误', async () => {
  const props = modalProps({
    tier: 'sms',
    maskedPhone: '137****3366',
    onSubmit: async () => ({ ok: false, code: 20002 }),
  });
  const view = render(createElement(StepUpModal, props));
  fireEvent.change(input(), { target: { value: '123456' } });
  await click(submit());
  await advance(20);
  view.rerender(createElement(StepUpModal, { ...props, open: false }));
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(createElement(StepUpModal, props));
  expect(resend().textContent).toMatch(/60\s*秒/);
  expect(input().value).toBe('');
  expect(screen.queryByRole('alert')).toBeNull();
});
