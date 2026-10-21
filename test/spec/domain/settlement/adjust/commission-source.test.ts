import { selectClawbackCommission } from '@couli/domain';
import { expect, it } from 'vitest';
import { source } from './fixtures.ts';

it('[AC-B2-04g#1] BR-FUND-08：整单失效优先，强制 N_new=0', () => {
  expect(
    selectClawbackCommission(
      source({
        full_invalid: true,
        settlement_seq_changed: true,
        settle_commission_fen: 600n,
        rights_deduct_fen: 250n,
      }),
    ),
  ).toEqual({ kind: 'available', n_new_fen: 0n, source: 'full_invalid' });
});

it.each([600n, 0n, -25n])(
  '[AC-B2-04g#2] BR-FUND-08：新 seq 的结算值 %s 优先于应扣佣金且保留负原值',
  (n) => {
    expect(
      selectClawbackCommission(
        source({
          settlement_seq_changed: true,
          settle_commission_fen: n,
          rights_deduct_fen: 250n,
          est_commission_fen: 800n,
          estimate_changed: true,
        }),
      ),
    ).toEqual({ kind: 'available', n_new_fen: n, source: 'settlement' });
  },
);

it.each([600n, 0n, -25n])('[AC-B2-04g#3] BR-FUND-08：没有结算额才使用本次新预估 %s', (n) => {
  expect(
    selectClawbackCommission(
      source({
        settle_commission_fen: null,
        est_commission_fen: n,
        estimate_changed: true,
        rights_deduct_fen: 250n,
      }),
    ),
  ).toEqual({ kind: 'available', n_new_fen: n, source: 'estimate' });
});

it.each([
  { deduction: 250n, expected: 750n },
  { deduction: 1000n, expected: 0n },
  { deduction: 1200n, expected: 0n },
  { deduction: 0n, expected: 1000n },
])(
  '[AC-B2-04g#4] BR-FUND-08：有旧结算额时忽略单独预估变化，按 booked_n 减应扣 $deduction',
  ({ deduction, expected }) => {
    expect(
      selectClawbackCommission(
        source({ est_commission_fen: 100n, estimate_changed: true, rights_deduct_fen: deduction }),
      ),
    ).toEqual({ kind: 'available', n_new_fen: expected, source: 'rights' });
  },
);

it.each([
  source(),
  source({ est_commission_fen: 1n, estimate_changed: true }),
  source({ settle_commission_fen: null, est_commission_fen: 700n }),
  source({ settle_commission_fen: null, adapter_estimate_fen: 500n }),
  source({ settle_commission_fen: 0n, est_commission_fen: 500n, estimate_changed: true }),
])('[AC-B2-04g#5] BR-FUND-08：无有效变化与应扣额，旧值和 Adapter 估算均不能代扣', (value) => {
  expect(selectClawbackCommission(value)).toEqual({ kind: 'wait_commission' });
});
