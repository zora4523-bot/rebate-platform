// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StepUpModal } from '../../../../apps/admin/src/components/step-up/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';
import { COPY, modalProps } from '../admin-stepup/fixtures.ts';

beforeEach(installMediaQuery);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const tier of ['totp', 'sms'] as const) {
  it(`[AC-F1-06r-MODAL#2] ${tier} 使用可见的 antd 遮罩，点击遮罩不取消验证`, () => {
    const onClose = vi.fn();
    render(createElement(StepUpModal, modalProps({ tier, maskedPhone: '137****3366', onClose })));
    const dialog = screen.getByRole('dialog', { name: COPY[tier].title });
    const wrap = dialog.closest('.ant-modal-wrap');
    expect(wrap, 'dialog must belong to an antd Modal wrap').not.toBeNull();
    const mask = wrap!.parentElement?.querySelector('.ant-modal-mask');
    expect(mask, 'the same Modal must render its antd mask').toBeInstanceOf(HTMLElement);
    expect(getComputedStyle(mask!).display).not.toBe('none');
    // rc-dialog handles outside clicks on the wrap, not on the mask sibling.
    fireEvent.mouseDown(wrap!);
    fireEvent.mouseUp(wrap!);
    fireEvent.click(wrap!);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: COPY[tier].title })).toBe(dialog);
  });

  it(`[AC-F1-06r-MODAL#1] ${tier} 使用 antd 弹窗、按钮与输入框，失败提示仍可读`, async () => {
    const onSubmit = vi.fn(async () => ({ ok: false as const, code: 20002 }));
    render(
      createElement(
        StepUpModal,
        modalProps({
          tier,
          maskedPhone: '137****3366',
          onSubmit,
          onResend: async () => ({ ok: true }),
        }),
      ),
    );
    const dialog = screen.getByRole('dialog', { name: COPY[tier].title });
    const controls = within(dialog);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // The frozen contract calls the SMS textbox 验证码, not 动态码.
    const input = controls.getByRole('textbox', { name: COPY[tier].label });
    expect(controls.getAllByRole('textbox')).toHaveLength(1);
    expect(input.matches('input.ant-input')).toBe(true);
    // tier is supplied by the caller; neither variant offers a tier switch.
    expect(controls.queryAllByRole('radio')).toHaveLength(0);
    const submit = controls.getByRole('button', { name: '验证并继续' });
    fireEvent.change(input, { target: { value: '123456' } });
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('123456');
    const message = await controls.findByText(COPY.incorrect);
    const errorSelector = '.ant-form-item-explain-error, .ant-alert-error';
    expect(message.closest(errorSelector)).not.toBeNull();
    expect(
      controls.queryAllByRole('alert').some((alert) => alert.textContent?.includes(COPY.incorrect)),
    ).toBe(true);
    // Keep these migration assertions together with the already-antd OTP/error contract:
    // every case is red on the handwritten modal, without making an already-green test.
    expect(dialog.closest('.ant-modal')).not.toBeNull();
    expect(controls.getByRole('button', { name: '关闭' }).matches('.ant-modal-close')).toBe(true);
    expect(controls.getByRole('button', { name: /^取\s*消$/ }).matches('button.ant-btn')).toBe(
      true,
    );
    expect(submit.matches('button.ant-btn.ant-btn-primary')).toBe(true);
    if (tier === 'sms')
      expect(controls.getByRole('button', { name: /重新发送/ }).matches('button.ant-btn')).toBe(
        true,
      );
  });
}
