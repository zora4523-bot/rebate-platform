import { expect, it } from 'vitest';
import type { OrderEntryRow } from '../infra/order-nets-store.ts';
import { LedgerError } from './errors.ts';
import { aggregateOrderNets } from './order-nets.ts';

const U = '00000000-0000-4000-8000-000000000001';

function row(voucher: string, values: Partial<OrderEntryRow>): OrderEntryRow {
  return {
    voucher_id: voucher,
    voucher_kind: null,
    beneficiary_user_id: null,
    role: null,
    amount_fen: null,
    ledger_type: null,
    sub_type: null,
    owner_type: null,
    owner_id: null,
    subject: null,
    ...values,
  };
}

function platform(voucher: string, subject: string, amount: bigint, values = {}): OrderEntryRow {
  return row(voucher, {
    amount_fen: amount,
    ledger_type: 'REBATE_CREDIT',
    owner_type: 'platform',
    owner_id: 'platform',
    subject,
    ...values,
  });
}

it('[AC-B2-04h-UNIT#1] R13 平台级恢复凭证（ADMIN_ADJUST RESTORE，不挂受益人）计入应收与平台净额', () => {
  const restore = {
    voucher_kind: 'ADMIN_ADJUST',
    ledger_type: 'ADMIN_ADJUST',
    sub_type: 'RESTORE',
  };
  const recon = {
    voucher_kind: 'ADMIN_ADJUST',
    ledger_type: 'ADMIN_ADJUST',
    sub_type: 'RECON_FIX',
  };
  const result = aggregateOrderNets([
    platform('v1', 'UNION_RECEIVABLE:taobao', 90n, restore),
    platform('v1', 'COMMISSION_REVENUE', -90n, restore),
    platform('v2', 'UNION_RECEIVABLE:taobao', 5n, recon),
    platform('v2', 'COMMISSION_REVENUE', -5n, recon),
  ]);
  expect(result).toEqual({
    beneficiaries: [],
    platform_net_fen: 95n,
    union_receivable_net_fen: 90n,
  });
});

it('[AC-B2-04h-UNIT#2] 无分录的受益人凭证仍保留零净额键；键不全不成键', () => {
  const result = aggregateOrderNets([
    row('v1', { voucher_kind: 'CLAWBACK', beneficiary_user_id: U, role: 'share' }),
    row('v2', { voucher_kind: 'CREDIT', beneficiary_user_id: U, role: null }),
    row('v3', { voucher_kind: 'FORFEIT', beneficiary_user_id: U, role: 'self' }),
  ]);
  expect(result).toEqual({
    beneficiaries: [{ beneficiary_user_id: U, role: 'share', net_fen: 0n }],
    platform_net_fen: 0n,
    union_receivable_net_fen: 0n,
  });
});

it('[AC-B2-04h-UNIT#3] 契约外角色的受益人键拒绝，不静默丢弃', () => {
  let caught: unknown;
  try {
    aggregateOrderNets([
      row('v1', {
        voucher_kind: 'CREDIT',
        beneficiary_user_id: U,
        role: 'owner',
        amount_fen: -1n,
        ledger_type: 'REBATE_CREDIT',
        owner_type: 'user',
        owner_id: U,
        subject: 'USER_BALANCE',
      }),
    ]);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LedgerError);
  expect((caught as LedgerError).code).toBe('ORDER_HISTORY_INVALID');
});
