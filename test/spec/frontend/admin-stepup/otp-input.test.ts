// @vitest-environment jsdom
import { createElement, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { OtpInput } from '../../../../apps/admin/src/components/otp-input/index.ts';
import { CELL_SELECTOR } from './fixtures.ts';

afterEach(cleanup);

function ControlledOtp() {
  const [value, setValue] = useState('');
  return createElement(OtpInput, {
    value,
    onChange: setValue,
    label: '动态码',
    hint: '请输入身份验证器中的 6 位动态码',
  });
}

it('[AC-F1-06f-OTP#1] 只有一个可访问输入框，六格仅作视觉展示', () => {
  render(createElement(ControlledOtp));
  const input = screen.getByRole('textbox', { name: '动态码' }) as HTMLInputElement;
  expect(document.querySelectorAll('input')).toHaveLength(1);
  expect(input.type).toBe('text');
  expect(input.getAttribute('maxlength')).toBe('6');
  expect(input.getAttribute('inputmode')).toBe('numeric');
  expect(input.getAttribute('autocomplete')).toBe('one-time-code');
  expect(screen.getByLabelText('动态码')).toBe(input);
  const hintId = input.getAttribute('aria-describedby');
  expect(hintId).toBeTruthy();
  expect(document.getElementById(hintId!)?.textContent).toBe('请输入身份验证器中的 6 位动态码');
  const cells = document.querySelectorAll(CELL_SELECTOR);
  expect(cells).toHaveLength(6);
  for (const cell of cells) {
    expect(cell.closest('[aria-hidden="true"]')).not.toBeNull();
    expect((cell as HTMLElement).tabIndex).toBe(-1);
  }
});

for (const [raw, expected] of [
  ['a1b2中3-4.5x6z7', '123456'],
  ['0001234', '000123'],
  ['１２٣abc', ''],
  ['', ''],
]) {
  it(`[AC-F1-06f-OTP#2] 输入 ${JSON.stringify(raw)} 只保留 ASCII 数字且截到六位`, () => {
    render(createElement(ControlledOtp));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: raw } });
    expect(input.value).toBe(expected);
  });
}

it('[AC-F1-06f-OTP#3] 粘贴带空格的六位码先清洗，不能被 maxlength 截掉后两位', async () => {
  const user = userEvent.setup();
  render(createElement(ControlledOtp));
  await user.click(screen.getByRole('textbox'));
  await user.paste('12 34 56');
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('123456');
});

it('[AC-F1-06f-OTP#4] 值受控、回调返回清洗值，autoFocus 与 invalid 可更新', () => {
  const onChange = vi.fn();
  const props = { value: '12', onChange, label: '验证码', hint: '输入六位码', autoFocus: true };
  const view = render(createElement(OtpInput, props));
  const input = screen.getByRole('textbox') as HTMLInputElement;
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: '12a34567' } });
  expect(onChange).toHaveBeenLastCalledWith('123456');
  expect(input.value).toBe('12');
  view.rerender(createElement(OtpInput, { ...props, value: '765432', invalid: true }));
  expect(input.value).toBe('765432');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  view.rerender(createElement(OtpInput, { ...props, invalid: false }));
  expect(input.getAttribute('aria-invalid')).not.toBe('true');
});
