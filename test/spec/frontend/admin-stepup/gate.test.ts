// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import {
  StepUpGate,
  type StepUpGateProps,
} from '../../../../apps/admin/src/components/step-up/index.ts';
import { COPY } from './fixtures.ts';

afterEach(cleanup);

function gateProps(overrides: Partial<StepUpGateProps> = {}): StepUpGateProps {
  return {
    tier: 'sms',
    verifyPhoneRegistered: false,
    children: '执行操作',
    onAction: vi.fn(),
    onRequestVerification: vi.fn(),
    ...overrides,
  };
}

for (const failure of [undefined, { code: 10003, reason: 'verify_phone_missing' }]) {
  it(`[AC-F1-06f-GATE#1] ${failure ? '服务端拒绝' : '账号未登记'} 时短信操作可聚焦但不可执行，提示关联按钮`, async () => {
    const user = userEvent.setup();
    const props = gateProps(failure ? { verifyPhoneRegistered: true, failure } : {});
    render(createElement(StepUpGate, props));
    const button = screen.getByRole('button', { name: '执行操作' }) as HTMLButtonElement;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    await user.tab();
    expect(document.activeElement).toBe(button);
    const ids = button.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.map((id) => document.getElementById(id)?.textContent).join(' ')).toContain(
      COPY.missingPhone,
    );
    await user.click(button);
    await user.keyboard('{Enter} ');
    expect(props.onAction).not.toHaveBeenCalled();
    expect(props.onRequestVerification).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
}

for (const tier of ['totp', 'sms', null] as const) {
  for (const activation of ['click', 'Enter', 'Space'] as const) {
    it(`[AC-F1-06f-GATE#2] ${tier ?? '无二次验证'} 档通过 ${activation} 走正确回调`, async () => {
      const user = userEvent.setup();
      const props = gateProps({ tier, verifyPhoneRegistered: tier === 'sms' });
      render(createElement(StepUpGate, props));
      const button = screen.getByRole('button', { name: '执行操作' }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-disabled')).not.toBe('true');
      expect(screen.queryByText(COPY.missingPhone)).toBeNull();
      if (activation === 'click') await user.click(button);
      else {
        button.focus();
        await user.keyboard(activation === 'Enter' ? '{Enter}' : ' ');
      }
      if (tier === null) {
        expect(props.onAction).toHaveBeenCalledTimes(1);
        expect(props.onRequestVerification).not.toHaveBeenCalled();
      } else {
        expect(props.onAction).not.toHaveBeenCalled();
        expect(props.onRequestVerification).toHaveBeenCalledExactlyOnceWith(tier);
      }
    });
  }
}
