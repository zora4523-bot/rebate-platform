import { checkAdjustmentReceivable, planCommissionAdjustment } from '@couli/domain';
import { expect, it } from 'vitest';
import { beneficiary, freezeInput, input } from './fixtures.ts';

it('[AC-B2-04g#6] BR-FUND-08 E-01：先换算 B，扣回含预留，booked 成对更新', () => {
  const result = planCommissionAdjustment(freezeInput(input()));
  expect(result).toMatchObject({
    route: 'immediate',
    transition: 'R9',
    rebate_status: 'CREDITED',
    ledger_type: 'CLAWBACK',
    reserve_fen: 120n,
    booked_after: { booked_base_fen: 480n, booked_n_fen: 600n },
    platform_after_fen: 312n,
    platform_delta_fen: -208n,
    union_receivable_delta_fen: -400n,
    void_pending_candidates: true,
    platform_posting: { amount_fen: 208n, debit: 'COMMISSION_REVENUE', credit: 'UNION_RECEIVABLE' },
  });
  expect(result.beneficiaries).toMatchObject([
    {
      user_id: 'u1',
      role: 'self',
      entitlement_fen: 240n,
      delta_fen: -160n,
      net_after_fen: 240n,
      posting: 'user_available',
    },
    {
      user_id: 'u2',
      role: 'direct',
      entitlement_fen: 48n,
      delta_fen: -32n,
      net_after_fen: 48n,
      posting: 'user_available',
    },
  ]);
});

it('[AC-B2-04g#7] BR-CALC-09：1235→1134 全额重算，不能把 ΔB 乘比例取整', () => {
  const result = planCommissionAdjustment(
    input({
      event: 'settlement',
      reserve_bp: 0n,
      booked_base_fen: 1235n,
      booked_n_fen: 1235n,
      n_new_fen: 1134n,
      platform_net_fen: 495n,
      beneficiaries: [
        beneficiary({ net_fen: 617n }),
        beneficiary({ user_id: 'u2', role: 'direct', ratio_bp: 1000n, net_fen: 123n }),
      ],
    }),
  );
  expect(result).toMatchObject({
    route: 'immediate',
    transition: 'R10',
    ledger_type: 'SETTLE_ADJUST',
    platform_delta_fen: -41n,
    union_receivable_delta_fen: -101n,
    void_pending_candidates: false,
  });
  expect(result.beneficiaries.map((row) => row.delta_fen)).toEqual([-50n, -10n]);
});

it.each(['clawback', 'settlement'] as const)(
  '[AC-B2-04g#8] BR-FUND-08/09：10→9 取整使平台正收 1，仍走整单负差 %s',
  (event) => {
    const result = planCommissionAdjustment(
      input({
        event,
        reserve_bp: 0n,
        booked_base_fen: 10n,
        booked_n_fen: 10n,
        n_new_fen: 9n,
        platform_net_fen: 4n,
        beneficiaries: [
          beneficiary({ ratio_bp: 3300n, net_fen: 3n }),
          beneficiary({ user_id: 'u2', role: 'direct', ratio_bp: 3300n, net_fen: 3n }),
        ],
      }),
    );
    expect(result).toMatchObject({
      route: 'immediate',
      platform_delta_fen: 1n,
      platform_after_fen: 5n,
      union_receivable_delta_fen: -1n,
      platform_posting: { amount_fen: 1n, debit: 'UNION_RECEIVABLE', credit: 'COMMISSION_REVENUE' },
    });
    expect(result.beneficiaries.map((row) => row.delta_fen)).toEqual([-1n, -1n]);
  },
);

it('[AC-B2-04g#9] BR-FUND-09：9→10 平台反向冲回 1 也必须随正差候选审批', () => {
  const result = planCommissionAdjustment(
    input({
      event: 'settlement',
      reserve_bp: 0n,
      booked_base_fen: 9n,
      booked_n_fen: 9n,
      n_new_fen: 10n,
      platform_net_fen: 5n,
      beneficiaries: [
        beneficiary({ ratio_bp: 3300n, net_fen: 2n }),
        beneficiary({ user_id: 'u2', role: 'direct', ratio_bp: 3300n, net_fen: 2n }),
      ],
    }),
  );
  expect(result).toMatchObject({
    route: 'approval',
    transition: 'R10',
    ledger_type: 'SETTLE_ADJUST',
    platform_delta_fen: -1n,
    union_receivable_delta_fen: 1n,
    platform_posting: { amount_fen: 1n, debit: 'COMMISSION_REVENUE', credit: 'UNION_RECEIVABLE' },
  });
  expect(result.beneficiaries.map((row) => row.delta_fen)).toEqual([1n, 1n]);
});

it.each([
  { old: 1001n, next: 1000n, platform: 701n, delta: -1n, route: 'immediate' },
  { old: 1000n, next: 1001n, platform: 700n, delta: 1n, route: 'approval' },
])(
  '[AC-B2-04g#10] BR-FUND-09：B 相同按 N 分路，仅调平台 $old→$next',
  ({ old, next, platform, delta, route }) => {
    const result = planCommissionAdjustment(
      input({
        event: 'settlement',
        reserve_bp: 5000n,
        booked_base_fen: 500n,
        booked_n_fen: old,
        n_new_fen: next,
        platform_net_fen: platform,
        beneficiaries: [
          beneficiary({ net_fen: 250n }),
          beneficiary({ user_id: 'u2', role: 'direct', ratio_bp: 1000n, net_fen: 50n }),
        ],
      }),
    );
    expect(result).toMatchObject({
      route,
      transition: 'R10',
      platform_delta_fen: delta,
      union_receivable_delta_fen: delta,
      booked_after: { booked_base_fen: 500n, booked_n_fen: next },
    });
    expect(result.beneficiaries.map((row) => [row.delta_fen, row.posting])).toEqual([
      [0n, null],
      [0n, null],
    ]);
  },
);

it.each(['clawback', 'settlement'] as const)(
  '[AC-B2-04g#11] BR-FUND-08/09：B 新旧均零而 N>0，%s 仍 CREDITED',
  (event) => {
    const result = planCommissionAdjustment(
      input({
        event,
        reserve_bp: 10000n,
        booked_base_fen: 0n,
        booked_n_fen: 1000n,
        platform_net_fen: 1000n,
        beneficiaries: [beneficiary({ net_fen: 0n })],
      }),
    );
    expect(result).toMatchObject({
      transition: event === 'clawback' ? 'R9' : 'R10',
      rebate_status: 'CREDITED',
      route: 'immediate',
      platform_delta_fen: -400n,
      union_receivable_delta_fen: -400n,
      booked_after: { booked_base_fen: 0n, booked_n_fen: 600n },
    });
    expect(result.beneficiaries).toMatchObject([{ delta_fen: 0n, posting: null }]);
  },
);

it.each([
  { reserve: 2000n, oldBase: 800n, next: 0n },
  { reserve: 2000n, oldBase: 800n, next: -100n },
  { reserve: 10000n, oldBase: 0n, next: 0n },
  { reserve: 10000n, oldBase: 0n, next: -1n },
])(
  '[AC-B2-04g#12] BR-FUND-08/23：N 正数部分归零一律 R8，包括旧 B=$oldBase',
  ({ reserve, oldBase, next }) => {
    const rows = oldBase === 0n ? [beneficiary({ net_fen: 0n })] : input().beneficiaries;
    const result = planCommissionAdjustment(
      input({
        event: 'settlement',
        n_new_fen: next,
        reserve_bp: reserve,
        booked_base_fen: oldBase,
        beneficiaries: rows,
        platform_net_fen: oldBase === 0n ? 1000n : 520n,
      }),
    );
    expect(result).toMatchObject({
      route: 'immediate',
      transition: 'R8',
      rebate_status: 'CLAWED_BACK',
      ledger_type: 'CLAWBACK',
      booked_after: { booked_base_fen: 0n, booked_n_fen: 0n },
      void_pending_candidates: true,
      union_receivable_delta_fen: -1000n,
    });
    expect(result.beneficiaries.every((row) => row.net_after_fen === 0n)).toBe(true);
  },
);

it('[AC-B2-04g#13] BR-CALC-23：N 仍正但原 B>0、新 B=0，取整归零也走 R8', () => {
  const result = planCommissionAdjustment(
    input({
      event: 'settlement',
      reserve_bp: 5000n,
      booked_base_fen: 1n,
      booked_n_fen: 2n,
      n_new_fen: 1n,
      beneficiaries: [beneficiary({ net_fen: 0n })],
      platform_net_fen: 2n,
    }),
  );
  expect(result).toMatchObject({
    transition: 'R8',
    ledger_type: 'CLAWBACK',
    rebate_status: 'CLAWED_BACK',
    booked_after: { booked_base_fen: 0n, booked_n_fen: 1n },
    platform_after_fen: 1n,
    union_receivable_delta_fen: -1n,
  });
});

it('[AC-B2-04g#14] BR-FUND-09：两值均相等无动作，无零额凭证', () => {
  const result = planCommissionAdjustment(input({ event: 'settlement', n_new_fen: 1000n }));
  expect(result).toMatchObject({
    route: 'none',
    transition: null,
    ledger_type: null,
    platform_delta_fen: 0n,
    platform_posting: null,
    union_receivable_delta_fen: 0n,
    booked_after: { booked_base_fen: 800n, booked_n_fen: 1000n },
    void_pending_candidates: false,
  });
  expect(result.beneficiaries.map((row) => [row.delta_fen, row.posting])).toEqual([
    [0n, null],
    [0n, null],
  ]);
});

it.each([
  { before: 0n, after: 0n, n: 600n, actual: -400n, expected: -400n, valid: true },
  { before: 400n, after: 240n, n: 600n, actual: -240n, expected: -240n, valid: true },
  { before: 400n, after: 240n, n: 600n, actual: -400n, expected: -240n, valid: false },
  { before: 0n, after: 100n, n: 1200n, actual: 100n, expected: 100n, valid: true },
  { before: 400n, after: 0n, n: -20n, actual: -600n, expected: -600n, valid: true },
  { before: 0n, after: 0n, n: 600n, actual: 400n, expected: -400n, valid: false },
])(
  '[AC-B2-04g#15] BR-FUND-08：独立核对 UNION_RECEIVABLE 实际影响 $actual，不能忽略义务变化',
  ({ before, after, n, actual, expected, valid }) => {
    expect(
      checkAdjustmentReceivable({
        booked_n_before_fen: 1000n,
        n_new_fen: n,
        pending_before_fen: before,
        pending_after_fen: after,
        actual_delta_fen: actual,
      }),
    ).toEqual({ valid, expected_delta_fen: expected });
  },
);
