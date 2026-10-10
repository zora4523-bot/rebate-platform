// @vitest-environment jsdom
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OtpInput } from '../../../../apps/admin/src/components/otp-input/index.ts';
import { installMediaQuery } from '../admin-auth-qr/helpers.ts';

beforeEach(installMediaQuery);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('[AC-F1-06p-OTP#1] 动态码封装只有一个 antd Input 并保留六位自动填充属性', () => {
  const { container } = render(
    createElement(OtpInput, {
      value: '',
      onChange: vi.fn(),
      label: '动态码',
      hint: '请输入身份验证器中的 6 位动态码',
    }),
  );
  const input = screen.getByRole('textbox', { name: '动态码' });
  expect(input.matches('input.ant-input')).toBe(true);
  expect(container.querySelectorAll('input')).toHaveLength(1);
  expect(input.getAttribute('maxlength')).toBe('6');
  expect(input.getAttribute('inputmode')).toBe('numeric');
  expect(input.getAttribute('autocomplete')).toBe('one-time-code');
  // 六格视觉、清洗、粘贴、焦点和受控行为由冻结的 admin-stepup/otp-input 覆盖。
});
