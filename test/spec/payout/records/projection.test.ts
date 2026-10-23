import { expect, it, vi } from 'vitest';
import {
  projectWithdrawalDetail,
  projectWithdrawalSummary,
  type WithdrawalRecordRow,
} from '../../../../apps/api/src/modules/payout/application/withdrawal-reads.ts';

const row: WithdrawalRecordRow = {
  id: '01920000-0000-7000-8000-000000000051',
  status: 'PAID_API',
  review_mode: 'auto',
  amount_fen: 12300n,
  fee_fen: 123n,
  tax_fen: 80n,
  net_fen: 12097n,
  payout_method: 'alipay',
  payout_channel: 'alipay',
  payee_account_cipher: Buffer.from('synthetic-cipher'),
  reject_reason_code: null,
  fail_code: null,
  created_at: new Date('2026-10-22T16:00:00.000Z'),
  channel_order_id: 'synthetic-channel-order',
  executed_at: new Date('2026-10-22T16:00:30.000Z'),
  paid_at: new Date('2026-10-22T16:01:00.000Z'),
};

it('[AC-B2-05f#3] 列表投影精确匹配契约，保留固化金额、时区、脱敏且不泄露内部字段', () => {
  const decrypt = vi.fn(() => '13812345678');
  const result = projectWithdrawalSummary(row, decrypt);
  expect(result).toEqual({
    withdrawal_id: row.id,
    status: 'PAID_API',
    review_mode: 'auto',
    amount_fen: 12300,
    fee_fen: 123,
    tax_fen: 80,
    net_fen: 12097,
    payout_channel: 'alipay',
    payout_channel_name: '支付宝',
    masked_account: '138****5678',
    reason_code: null,
    fail_action: null,
    created_at: '2026-10-23T00:00:00.000+08:00',
    // review_mode=auto：无人工审核期限；支付宝单：无微信确认态与确认期限。
    review_deadline: null,
    executed_at: '2026-10-23T00:00:30.000+08:00',
    // payout_attempts 读端口接上前为 null，见 B2-06a
    first_attempt_at: null,
    paid_at: '2026-10-23T00:01:00.000+08:00',
    channel_state: null,
    confirm_deadline: null,
    // BR-WDR-25 分支表「PAID_API / PAID_MANUAL」行，按状态分开：PAID_API → paid_api。
    sub_text_branch: 'paid_api',
    // W10 未实现（B2-09）。
    hold_days: null,
  });
  expect(decrypt).toHaveBeenCalledExactlyOnceWith(row.payee_account_cipher, 'alipay');
});

it.each([
  ['PAID_API', 'alipay', '支付宝', 'zhangsan@example.com', 'zh***@example.com'],
  ['PAID_MANUAL', 'alipay', '支付宝', '13812345678', '138****5678'],
  ['PAID_API', 'bank_card', '银行卡', '6222021234567890123', '尾号 0123'],
  ['PAID_MANUAL', 'bank_card', '银行卡', '6222021234567890123', '尾号 0123'],
])('[AC-B2-05f#4] %s / %s 读取该单通道并按快照账号脱敏', (status, channel, name, raw, masked) => {
  const result = projectWithdrawalSummary(
    { ...row, status, payout_channel: channel, payout_method: channel },
    () => raw,
  );
  expect(result.payout_channel).toBe(channel);
  expect(result.payout_channel_name).toBe(name);
  expect(result.masked_account).toBe(masked);
  expect(JSON.stringify(result)).not.toContain(raw);
});

it('[AC-B2-05f#5] 通道名按 payout_channel，账号脱敏按快照 payout_method', () => {
  expect(
    projectWithdrawalSummary(
      { ...row, status: 'PAID_MANUAL', payout_channel: 'bank_card' },
      () => '13812345678',
    ),
  ).toMatchObject({
    payout_channel: 'bank_card',
    payout_channel_name: '银行卡',
    masked_account: '138****5678',
  });
});

it.each([
  ['PENDING_REVIEW', 'PAYEE_NOT_EXIST', null, null],
  ['APPROVED', 'PAYEE_NOT_EXIST', null, null],
  ['PAYING', 'PAYEE_NOT_EXIST', null, null],
  ['PAID_API', 'PAYEE_NOT_EXIST', null, null],
  ['PAID_MANUAL', 'PAYEE_NOT_EXIST', null, null],
  ['REJECTED', 'PAYEE_NOT_EXIST', 'USER_REQUEST', null],
  ['FAILED', 'PAYEE_NOT_EXIST', 'PAYEE_NOT_EXIST', 'change_payout_account'],
  ['FAILED', 'PAYEE_ACCOUNT_FROZEN', 'PAYEE_ACCOUNT_FROZEN', null],
  ['FAILED', 'PAYEE_FUTURE_CODE', 'PAYEE_FUTURE_CODE', null],
  ['FAILED', 'PAYER_BALANCE_NOT_ENOUGH', 'PAYER_BALANCE_NOT_ENOUGH', null],
  ['FAILED', 'X_PAYEE_NOT_EXIST', 'X_PAYEE_NOT_EXIST', null],
  ['FAILED', 'payee_not_exist', 'payee_not_exist', null],
  ['FAILED', 'PAYEE', 'PAYEE', null],
  ['FAILED', null, null, null],
])('[AC-B2-05f#6] %s / %s 的原因来源与账号修改入口', (status, fail, reason, action) => {
  const input = { ...row, status: status!, fail_code: fail, reject_reason_code: 'USER_REQUEST' };
  const summary = projectWithdrawalSummary(input, () => '13812345678');
  expect(summary.reason_code).toBe(reason);
  expect(summary.fail_action).toBe(action);
  const detail = projectWithdrawalDetail(input, () => '13812345678');
  expect(detail.reason_code).toBe(reason);
  expect(detail.fail_action).toBe(action);
});

it.each([
  ['PENDING_REVIEW', 'channel-order', null],
  ['APPROVED', 'channel-order', null],
  ['PAYING', 'channel-order', null],
  ['REJECTED', 'channel-order', null],
  ['FAILED', 'channel-order', null],
  ['PAID_API', 'channel-order', 'channel-order'],
  ['PAID_MANUAL', 'manual-order', 'manual-order'],
  ['PAID_API', null, null],
  ['PAID_MANUAL', null, null],
])('[AC-B2-05f#7] %s 流水号 %s 只在成功详情公开', (status, channelId, expected) => {
  const input = { ...row, status: status!, channel_order_id: channelId };
  const summary = projectWithdrawalSummary(input, () => '13812345678');
  const detail = projectWithdrawalDetail(input, () => '13812345678');
  expect(summary).not.toHaveProperty('channel_order_id');
  expect(detail).toEqual({ ...summary, channel_order_id: expected });
});

it('[AC-B2-05f#8] review_mode 未判定时保留 null；金额不套用当前 MVP 零手续费重算', () => {
  expect(
    projectWithdrawalSummary({ ...row, review_mode: null }, () => '13812345678'),
  ).toMatchObject({
    review_mode: null,
    amount_fen: 12300,
    fee_fen: 123,
    tax_fen: 80,
    net_fen: 12097,
  });
});
