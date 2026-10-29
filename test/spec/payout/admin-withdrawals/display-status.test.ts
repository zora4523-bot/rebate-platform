// B2-09c display status rule test (claude-independent, SPEC_REF 37808a50): contracts/openapi.yaml
// AdminWithdrawalDisplayStatus (enum admin_withdrawal_display_status, BR-WDR-08 细则, 花卷云「会员
// 提现管理」mapping): pending_review = PENDING_REVIEW, or APPROVED with hold_reason other than
// payer_side_after_transfer; pending_handle = APPROVED with hold_reason payer_side_after_transfer;
// rejected = REJECTED; paid_manual = PAID_MANUAL; paid_auto_system = PAID_API with review_mode auto;
// paid_auto_review = PAID_API otherwise; paying = PAYING (needs_manual included); failed = FAILED.
// Exhaustive over status × review_mode (null, auto, manual) × hold_reason (null and the seven
// withdrawal_hold_reason values) × needs_manual. Pure function, no database.
import { expect, it } from 'vitest';
import { adminWithdrawalDisplayStatus } from '../../../../apps/api/src/modules/payout/application/admin-withdrawals.ts';

const STATUSES = [
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'PAYING',
  'PAID_API',
  'PAID_MANUAL',
  'FAILED',
] as const;
const MODES = [null, 'auto', 'manual'] as const;
const HOLDS = [
  null,
  'payout_disabled',
  'queue_paused',
  'channel_disabled',
  'member_blocked',
  'single_cap',
  'daily_cap',
  'payer_side_after_transfer',
] as const;

/** The table of the contract, row by row (test-side oracle). */
function expected(
  status: (typeof STATUSES)[number],
  mode: (typeof MODES)[number],
  hold: (typeof HOLDS)[number],
): string {
  if (status === 'PENDING_REVIEW') return 'pending_review';
  if (status === 'APPROVED') {
    return hold === 'payer_side_after_transfer' ? 'pending_handle' : 'pending_review';
  }
  if (status === 'REJECTED') return 'rejected';
  if (status === 'PAID_MANUAL') return 'paid_manual';
  if (status === 'PAID_API') return mode === 'auto' ? 'paid_auto_system' : 'paid_auto_review';
  if (status === 'PAYING') return 'paying';
  return 'failed';
}

it('[AC-B2-09c#16] display_status 推导覆盖 status × review_mode × hold_reason × needs_manual 的全部组合：只有 APPROVED 看 hold_reason（payer_side_after_transfer 为 pending_handle，其余与 null 为 pending_review），只有 PAID_API 看 review_mode（auto 为 paid_auto_system，manual 与 null 为 paid_auto_review），needs_manual 不改变结果；八个取值都会出现', () => {
  // [status, review_mode, hold_reason, needs_manual, display_status]
  const examples = [
    ['PENDING_REVIEW', null, null, false, 'pending_review'],
    ['APPROVED', 'auto', 'queue_paused', false, 'pending_review'],
    ['APPROVED', 'manual', 'payer_side_after_transfer', false, 'pending_handle'],
    ['PAID_API', 'auto', null, false, 'paid_auto_system'],
    ['PAID_API', null, null, false, 'paid_auto_review'],
    ['PAYING', 'auto', null, true, 'paying'],
  ] as const;
  for (const [status, mode, hold, needsManual, display] of examples) {
    const row = { status, review_mode: mode, hold_reason: hold, needs_manual: needsManual };
    expect(adminWithdrawalDisplayStatus(row), JSON.stringify(row)).toBe(display);
  }

  const wrong: string[] = [];
  const seen = new Set<string>();
  for (const status of STATUSES) {
    for (const mode of MODES) {
      for (const hold of HOLDS) {
        for (const needsManual of [false, true]) {
          const row = { status, review_mode: mode, hold_reason: hold, needs_manual: needsManual };
          const got = adminWithdrawalDisplayStatus(row);
          const want = expected(status, mode, hold);
          seen.add(got);
          if (got !== want) wrong.push(`${JSON.stringify(row)} → ${got}, want ${want}`);
        }
      }
    }
  }
  expect(wrong).toEqual([]);
  expect([...seen].sort()).toEqual([
    'failed',
    'paid_auto_review',
    'paid_auto_system',
    'paid_manual',
    'paying',
    'pending_handle',
    'pending_review',
    'rejected',
  ]);
});
