import { describe, expect, it } from 'vitest';
import { statusTitle, subTextBranch, type WithdrawalDisplayRow } from './display.ts';

const base: WithdrawalDisplayRow = {
  status: 'APPROVED',
  review_mode: 'auto',
  auto_decision: {},
  review_deadline: null,
  executed_at: null,
  first_attempt_at: null,
  needs_manual: false,
  manual_resolution: null,
  fail_code: null,
  payout_channel: 'wechat',
  channel_state: null,
  confirm_deadline: null,
};

describe('display (Codex money r1 S2)', () => {
  it('reads titles as own properties only: prototype names are unknown statuses', () => {
    expect(statusTitle('constructor')).toBe('处理中');
    expect(statusTitle('toString')).toBe('处理中');
    expect(statusTitle('__proto__')).toBe('处理中');
    expect(statusTitle('PAID_API')).toBe('已到账');
  });

  it('never promises the automatic arrival for a WeChat withdrawal', () => {
    const now = new Date('2026-10-23T04:00:00.000Z');
    expect(subTextBranch(base, now)).toBe('processing');
    expect(subTextBranch({ ...base, status: 'PAYING', channel_state: 'processing' }, now)).toBe(
      'wechat_processing',
    );
    expect(subTextBranch({ ...base, payout_channel: 'alipay' }, now)).toBe('auto_expected_soon');
  });
});
