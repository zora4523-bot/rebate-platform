import { expect, it } from 'vitest';
import {
  statusTitle,
  payoutChannelName,
  subTextBranch,
  type WithdrawalDisplayRow,
  type WithdrawalSubTextBranch,
} from '../../../../apps/api/src/modules/payout/domain/display.ts';

// BR-TEXT-06, BR-WDR-25 and BR-WDR-08 only. No dictionary wording is invented here.
it.each([
  ['PENDING_REVIEW', '审核中'],
  ['APPROVED', '审核中'],
  ['PAYING', '打款中'],
  ['PAID_API', '已到账'],
  ['PAID_MANUAL', '已到账'],
  ['REJECTED', '未通过'],
  ['FAILED', '打款未成功'],
  ['FUTURE_STATUS', '处理中'],
  ['', '处理中'],
])('[AC-B2-05f#1] 标题 %s → %s', (status, title) => {
  expect(statusTitle(status)).toBe(title);
});

it.each([
  ['alipay', '支付宝'],
  ['bank_card', '银行卡'],
  ['wechat', '微信零钱'],
] as const)('[AC-B2-05f#9] 通道 %s 的名称为 %s', (channel, name) => {
  expect(payoutChannelName(channel)).toBe(name);
});

const now = new Date('2026-10-23T04:00:00.000Z');
const recent = new Date('2026-10-23T02:00:00.001Z');
const boundary = new Date('2026-10-23T02:00:00.000Z');
const earlier = new Date('2026-10-23T01:00:00.000Z');
const future = new Date('2026-10-23T04:00:00.001Z');
const base: WithdrawalDisplayRow = {
  status: 'PAYING',
  review_mode: 'manual',
  auto_decision: { eligible: false },
  review_deadline: future,
  executed_at: recent,
  first_attempt_at: null,
  needs_manual: false,
  manual_resolution: null,
  fail_code: null,
  payout_channel: 'alipay',
  channel_state: null,
  confirm_deadline: null,
};

interface BranchCase {
  name: string;
  patch: Partial<WithdrawalDisplayRow>;
  branch: WithdrawalSubTextBranch;
}

const cases: BranchCase[] = [
  {
    name: '尚未完成自动判定优先于已过人工审核截止时间',
    patch: { status: 'PENDING_REVIEW', auto_decision: null, review_deadline: earlier },
    branch: 'processing',
  },
  {
    name: '人工审核截止前 1ms',
    patch: { status: 'PENDING_REVIEW' },
    branch: 'manual_review_pending',
  },
  {
    name: '人工审核恰好到期',
    patch: { status: 'PENDING_REVIEW', review_deadline: now },
    branch: 'manual_review_overdue',
  },
  {
    name: '人工审核已过期',
    patch: { status: 'PENDING_REVIEW', review_deadline: earlier },
    branch: 'manual_review_overdue',
  },
  {
    name: '自动审核通过优先于 APPROVED 通用行',
    patch: { status: 'APPROVED', review_mode: 'auto', executed_at: null },
    branch: 'auto_expected_soon',
  },
  {
    name: '自动打款 T+2h 前 1ms',
    patch: { review_mode: 'auto' },
    branch: 'auto_expected_soon',
  },
  {
    name: '自动打款恰好 T+2h 不再承诺预计几分钟',
    patch: { review_mode: 'auto', executed_at: boundary },
    branch: 'paying_delayed',
  },
  {
    name: '自动打款已经延迟',
    patch: { review_mode: 'auto', executed_at: earlier },
    branch: 'paying_delayed',
  },
  {
    name: '自动路径 execute_blocked 转 APPROVED 通用行',
    patch: {
      status: 'APPROVED',
      review_mode: 'auto',
      auto_decision: { execute_blocked: 'queue_paused' },
    },
    branch: 'processing',
  },
  {
    name: '自动路径 execute_blocked 转 PAYING 通用行',
    patch: { review_mode: 'auto', auto_decision: { execute_blocked: 'queue_paused' } },
    branch: 'channel_processing',
  },
  {
    name: '人工 APPROVED 含 W9 退回不承诺自动到账',
    patch: { status: 'APPROVED' },
    branch: 'processing',
  },
  { name: '人工打款 T+2h 前 1ms', patch: {}, branch: 'channel_processing' },
  {
    name: '人工打款恰好 T+2h',
    patch: { executed_at: boundary },
    branch: 'paying_delayed',
  },
  {
    name: 'needs_manual 即使未满两小时也显示延迟',
    patch: { needs_manual: true },
    branch: 'paying_delayed',
  },
  {
    name: 'needs_manual 阻止自动路径优先行',
    patch: { review_mode: 'auto', needs_manual: true },
    branch: 'paying_delayed',
  },
  {
    name: 'T 取首次尝试，较新的 executed_at 不能重置计时',
    patch: { first_attempt_at: boundary, executed_at: recent },
    branch: 'paying_delayed',
  },
  {
    name: '首次尝试优先于较早的 executed_at',
    patch: { first_attempt_at: recent, executed_at: earlier },
    branch: 'channel_processing',
  },
  { name: '接口成功', patch: { status: 'PAID_API' }, branch: 'paid_api' },
  { name: '人工成功分句', patch: { status: 'PAID_MANUAL' }, branch: 'paid_manual' },
  { name: '驳回原因与全额退回分支', patch: { status: 'REJECTED' }, branch: 'rejected' },
  {
    name: 'W6 账号失败',
    patch: { status: 'FAILED', fail_code: 'PAYEE_NOT_EXIST' },
    branch: 'failed_account',
  },
  {
    name: 'W6 非账号失败',
    patch: { status: 'FAILED', fail_code: 'PAYER_BALANCE_NOT_ENOUGH' },
    branch: 'failed_other',
  },
  {
    name: 'W10 不误入 W6 账号失败分支',
    patch: {
      status: 'FAILED',
      fail_code: 'PAYEE_NOT_EXIST',
      needs_manual: true,
      manual_resolution: 'failed',
    },
    branch: 'failed_manual',
  },
  {
    name: 'W10 非账号失败',
    patch: {
      status: 'FAILED',
      fail_code: 'UNKNOWN',
      needs_manual: true,
      manual_resolution: 'failed',
    },
    branch: 'failed_manual',
  },
  {
    name: '微信待确认优先于自动与两小时延迟行',
    patch: {
      payout_channel: 'wechat',
      review_mode: 'auto',
      channel_state: 'wait_user_confirm',
      confirm_deadline: future,
      executed_at: earlier,
    },
    branch: 'wechat_wait_confirm',
  },
  {
    name: '微信确认恰好到期',
    patch: {
      payout_channel: 'wechat',
      channel_state: 'wait_user_confirm',
      confirm_deadline: now,
    },
    branch: 'wechat_confirm_expired',
  },
  {
    name: '微信正在取消',
    patch: { payout_channel: 'wechat', channel_state: 'canceling' },
    branch: 'wechat_canceling',
  },
  {
    name: '微信其他未满两小时不承诺自动到账',
    patch: { payout_channel: 'wechat', review_mode: 'auto', channel_state: 'processing' },
    branch: 'wechat_processing',
  },
  {
    name: '微信 needs_manual 不再显示去确认收款',
    patch: {
      payout_channel: 'wechat',
      channel_state: 'wait_user_confirm',
      confirm_deadline: future,
      needs_manual: true,
    },
    branch: 'paying_delayed',
  },
  {
    name: '微信其他状态恰好两小时走通用延迟行',
    patch: { payout_channel: 'wechat', executed_at: boundary },
    branch: 'paying_delayed',
  },
];

it.each(cases)('[AC-B2-05f#2] $name', ({ patch, branch }) => {
  const row = { ...base, ...patch };
  const before = structuredClone(row);
  expect(subTextBranch(row, now)).toBe(branch);
  expect(row).toEqual(before);
  expect(now.toISOString()).toBe('2026-10-23T04:00:00.000Z');
});
