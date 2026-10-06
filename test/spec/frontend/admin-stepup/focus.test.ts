// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { StepUpModal } from '../../../../apps/admin/src/components/step-up/index.ts';
import { COPY, modalProps } from './fixtures.ts';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

function linkedText(element: Element, attribute: string): string {
  const ids = element.getAttribute(attribute)?.trim().split(/\s+/) ?? [];
  expect(ids.length).toBeGreaterThan(0);
  return ids
    .map((id) => {
      const target = document.getElementById(id);
      expect(target).not.toBeNull();
      return target!.textContent;
    })
    .join(' ');
}

for (const tier of ['totp', 'sms'] as const) {
  it(`[AC-S1-157#3][AC-F1-06f-FOCUS#1] ${tier} 对话框关联标题与说明，初始焦点在标题`, () => {
    render(createElement(StepUpModal, modalProps({ tier, maskedPhone: '137****3366' })));
    const dialog = screen.getByRole('dialog', { name: COPY[tier].title });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(linkedText(dialog, 'aria-labelledby')).toBe(COPY[tier].title);
    const description = linkedText(dialog, 'aria-describedby');
    expect(description).toContain('本次操作：');
    expect(description).toContain('查看完整手机号');
    expect(description).toContain('对象：用户 U10023 · 本次查看会记入操作日志');
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!);
    expect(title?.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(title);
    const input = screen.getByRole('textbox');
    expect(linkedText(input, 'aria-describedby')).toContain(COPY[tier].hint);
  });

  it(`[AC-S1-157#6][AC-F1-06f-FOCUS#2] ${tier} Tab 与 Shift+Tab 按控件顺序在弹窗内循环`, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      createElement(
        StepUpModal,
        modalProps({ tier, maskedPhone: '137****3366', onResend: async () => ({ ok: true }) }),
      ),
    );
    // Initially submit and SMS resend are disabled and must be omitted from the tab order.
    const close = screen.getByRole('button', { name: '关闭' });
    const input = screen.getByRole('textbox');
    const cancel = screen.getByRole('button', { name: '取消' });
    for (const target of [close, input, cancel, close]) {
      await user.tab();
      expect(document.activeElement).toBe(target);
    }
    await user.click(input);
    await user.type(input, '123456');
    for (let second = 0; second < 60; second++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }
    close.focus();
    const order = [
      close,
      ...(tier === 'sms' ? [screen.getByRole('button', { name: '重新发送' })] : []),
      input,
      cancel,
      screen.getByRole('button', { name: '验证并继续' }),
    ];
    for (const target of [...order.slice(1), close]) {
      await user.tab();
      expect(document.activeElement).toBe(target);
    }
    for (const target of [...order].reverse()) {
      await user.tab({ shift: true });
      expect(document.activeElement).toBe(target);
    }
  });
}

for (const dismissal of ['Escape', '取消', '关闭'] as const) {
  it(`[AC-S1-157#6][AC-F1-06f-FOCUS#3] ${dismissal} 通知调用方关闭，解除背景隔离并还焦点`, async () => {
    const user = userEvent.setup();
    const background = document.createElement('main');
    background.id = 'root';
    const trigger = document.createElement('button');
    trigger.textContent = '触发操作';
    background.append(trigger);
    document.body.append(background);
    trigger.focus();
    const onClose = vi.fn();
    const props = modalProps({ onClose });
    const view = render(createElement(StepUpModal, props));
    expect(background.hasAttribute('inert')).toBe(true);
    expect(background.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('dialog').closest('[inert], [aria-hidden="true"]')).toBeNull();
    if (dismissal === 'Escape') await user.keyboard('{Escape}');
    else await user.click(screen.getByRole('button', { name: dismissal }));
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(createElement(StepUpModal, { ...props, open: false }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(background.hasAttribute('inert')).toBe(false);
    expect(background.hasAttribute('aria-hidden')).toBe(false);
  });
}

it('[AC-F1-06f-FOCUS#4] 显式传入应用根时隔离该根；open=false 不抢焦点', () => {
  const background = document.createElement('main');
  const trigger = document.createElement('button');
  background.append(trigger);
  document.body.append(background);
  trigger.focus();
  const props = modalProps({ open: false, applicationRoot: background });
  const view = render(createElement(StepUpModal, props));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(background.hasAttribute('inert')).toBe(false);
  view.rerender(createElement(StepUpModal, { ...props, open: true }));
  expect(background.hasAttribute('inert')).toBe(true);
  expect(background.getAttribute('aria-hidden')).toBe('true');
  expect(screen.getByRole('dialog').closest('[inert], [aria-hidden="true"]')).toBeNull();
});
