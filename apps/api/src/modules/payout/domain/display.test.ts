import { describe, expect, it } from 'vitest';
import {
  isAccountFailure,
  statusTitle,
  subTextBranch,
  type WithdrawalDisplayRow,
} from './display.ts';

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

describe('display (D10-228 ②: 以 08 为准)', () => {
  const now = new Date('2026-10-23T04:00:00.000Z');

  it('a WeChat withdrawal waiting for the user without a recorded deadline is still processing', () => {
    const row: WithdrawalDisplayRow = {
      ...base,
      status: 'PAYING',
      channel_state: 'wait_user_confirm',
      confirm_deadline: null,
    };
    expect(subTextBranch(row, now)).toBe('wechat_processing');
    expect(subTextBranch({ ...row, confirm_deadline: new Date(now.getTime() + 1) }, now)).toBe(
      'wechat_wait_confirm',
    );
    expect(subTextBranch({ ...row, confirm_deadline: now }, now)).toBe('wechat_confirm_expired');
  });

  it('an unknown status has a title but no sub-text branch', () => {
    expect(statusTitle('FUTURE_STATUS')).toBe('处理中');
    expect(subTextBranch({ ...base, status: 'FUTURE_STATUS' }, now)).toBeNull();
    expect(subTextBranch({ ...base, status: 'constructor' }, now)).toBeNull();
  });
});

describe('display (D10-228 ② (b): account failures code by code, BR-TEXT-08)', () => {
  it('offers the payout-account change only for the listed codes', () => {
    expect(isAccountFailure('PAYEE_NOT_EXIST')).toBe(true);
    expect(isAccountFailure('PAYEE_USER_INFO_ERROR')).toBe(true);
    expect(isAccountFailure('PAYEE_ACCOUNT_STATUS_ERROR')).toBe(true);
    expect(isAccountFailure('PAYEE_ACCOUNT_FROZEN')).toBe(false);
    expect(isAccountFailure('PAYEE_FUTURE_CODE')).toBe(false);
    expect(isAccountFailure('payee_not_exist')).toBe(false);
    expect(isAccountFailure('PAYER_BALANCE_NOT_ENOUGH')).toBe(false);
    expect(isAccountFailure(null)).toBe(false);
  });
});

describe('display (D10-233 ②: NEGATIVE_BALANCE rejection)', () => {
  const now = new Date('2026-10-23T04:00:00.000Z');

  it('reads a negative-balance rejection as rejected_offset and every other rejection as rejected', () => {
    expect(
      subTextBranch({ ...base, status: 'REJECTED', reject_reason_code: 'NEGATIVE_BALANCE' }, now),
    ).toBe('rejected_offset');
    expect(
      subTextBranch({ ...base, status: 'REJECTED', reject_reason_code: 'USER_REQUEST' }, now),
    ).toBe('rejected');
    expect(subTextBranch({ ...base, status: 'REJECTED' }, now)).toBe('rejected');
  });
});
