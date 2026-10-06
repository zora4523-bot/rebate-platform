import type { StepUpModalProps } from '../../../../apps/admin/src/components/step-up/index.ts';

export const COPY = {
  totp: {
    title: '二次验证 · 动态码',
    label: '动态码',
    hint: '请输入身份验证器中的 6 位动态码',
  },
  sms: {
    title: '二次验证 · 短信',
    label: '验证码',
    hint: '请输入短信中的 6 位验证码；短信发到本后台账号登记的验证手机号',
  },
  missingPhone: '这项操作需要短信验证，请先登记验证手机号',
  incorrect: '验证码错误，请重新输入',
  expired: '验证码已失效，请重新获取',
  frequent: '操作太频繁，请稍后再试',
  generic: '验证失败，请稍后重试',
  smsExplanation: '这一类操作会改动账户余额，需要短信验证；本次验证会记入操作日志。',
} as const;

export function modalProps(overrides: Partial<StepUpModalProps> = {}): StepUpModalProps {
  return {
    open: true,
    tier: 'totp',
    operation: '查看完整手机号',
    details: ['对象：用户 U10023 · 本次查看会记入操作日志'],
    onSubmit: async () => ({ ok: true, stepUpToken: 'fixture-step-up-token' }),
    onClose: () => {},
    onVerified: () => {},
    ...overrides,
  };
}

// Shared observable markup contract: each of the six decorative cells has data-otp-cell.
export const CELL_SELECTOR = '[data-otp-cell]';
