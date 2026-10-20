import { planCommissionAdjustment } from '@couli/domain';
import type { AdjustmentBeneficiary, AdjustmentInput } from '@couli/domain';
import { createPropStats, propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { beneficiary, freezeInput } from '../../../../spec/domain/settlement/adjust/fixtures.ts';

// 独立 bigint 算术 oracle，不调用分佣实现；覆盖超过 Number 安全整数的金额。
const positiveN = fc.oneof(
  fc.bigInt({ min: 0n, max: 10000000000000000n }),
  fc.constantFrom(0n, 1n, 2n, 10000n, 12345n, 9007199254740993n),
);
const reserveBp = fc.bigInt({ min: 0n, max: 9999n });
const ratios = fc.tuple(
  fc.bigInt({ min: 0n, max: 5000n }),
  fc.bigInt({ min: 0n, max: 2000n }),
  fc.bigInt({ min: 0n, max: 1000n }),
);

function baseline(n: bigint, reserve: bigint, bp: readonly bigint[]): AdjustmentInput {
  const base = (n * (10000n - reserve)) / 10000n;
  const rows = bp.map((ratio_bp, i) =>
    beneficiary({
      user_id: `u${i}`,
      role: i === 0 ? 'self' : i === 1 ? 'direct' : 'indirect',
      ratio_bp,
      net_fen: (base * ratio_bp) / 10000n,
    }),
  );
  return {
    event: 'settlement',
    n_new_fen: n,
    reserve_bp: reserve,
    booked_base_fen: base,
    booked_n_fen: n,
    platform_net_fen: n - rows.reduce((sum, row) => sum + row.net_fen, 0n),
    beneficiaries: rows,
  };
}

it('[AC-B2-04g#36] BR-CALC-09：任意多次获批调整等于新基数一次性重算，修正 A→B→A 不积累尾差', () => {
  const params = propParams();
  const stats = createPropStats('B2-04g:full-recalculation');
  fc.assert(
    fc.property(
      positiveN,
      fc.array(positiveN, { minLength: 2, maxLength: 8 }),
      reserveBp,
      ratios,
      (start, changes, reserve, bp) => {
        stats.hit(start > 9007199254740991n ? 'above-safe-integer' : 'ordinary');
        const initial = baseline(start, reserve, bp);
        let current = initial;
        let valid = true;
        // 最后回到 A，涵盖两路、重放、独立计算与累计误差；每个 approval 均视为已获批。
        for (const next of [...changes, start]) {
          const before = freezeInput({ ...current, n_new_fen: next });
          const result = planCommissionAdjustment(before);
          const base = (next * (10000n - reserve)) / 10000n;
          const expected = bp.map((ratio) => (base * ratio) / 10000n);
          valid &&=
            result.booked_after.booked_base_fen === base &&
            result.booked_after.booked_n_fen === next &&
            result.beneficiaries.length === bp.length &&
            result.beneficiaries.every(
              (row, i) =>
                row.net_after_fen === expected[i] &&
                row.delta_fen === expected[i]! - before.beneficiaries[i]!.net_fen &&
                row.pending_after_fen === 0n,
            ) &&
            result.platform_after_fen === next - expected.reduce((sum, value) => sum + value, 0n) &&
            result.union_receivable_delta_fen === next - current.booked_n_fen;
          current = {
            ...before,
            ...result.booked_after,
            platform_net_fen: result.platform_after_fen,
            beneficiaries: before.beneficiaries.map((row, i) => ({
              ...row,
              net_fen: result.beneficiaries[i]!.net_after_fen,
            })),
          };
        }
        const replay = planCommissionAdjustment(current);
        return (
          valid &&
          current.platform_net_fen === initial.platform_net_fen &&
          current.beneficiaries.every(
            (row, i) => row.net_fen === initial.beneficiaries[i]!.net_fen,
          ) &&
          replay.route === 'none' &&
          replay.platform_posting === null &&
          replay.beneficiaries.every((row) => row.delta_fen === 0n && row.posting === null)
        );
      },
    ),
    params,
  );
  const record = stats.flush();
  expect({
    runs: Object.values(record.hits).reduce((sum, count) => sum + count, 0),
    discards: record.discards,
  }).toEqual({ runs: params.numRuns, discards: 0 });
}, 120_000);

const states: readonly Partial<AdjustmentBeneficiary>[] = [
  {},
  { risk_state: 'frozen' },
  { risk_state: 'appealing' },
  { risk_state: 'banned' },
  { deletion_status: 'processing' },
  { deletion_status: 'done' },
  { is_minor: true, role: 'share' },
  { is_minor: true, role: 'self' },
  { status: 'forfeited' },
];

it('[AC-B2-04g#37] BR-CALC-09/FUND-08：各状态连续扣回后受益人净额非负，坏账也减少净额', () => {
  const params = propParams();
  const stats = createPropStats('B2-04g:nonnegative-net');
  fc.assert(
    fc.property(
      positiveN,
      reserveBp,
      fc.bigInt({ min: 0n, max: 8000n }),
      fc.array(fc.bigInt({ min: 0n, max: 10000n }), { minLength: 2, maxLength: 6 }),
      fc.integer({ min: 0, max: states.length - 1 }),
      (start, reserve, bp, factors, stateIndex) => {
        stats.hit(`state-${stateIndex}`);
        const state = states[stateIndex]!;
        let current = baseline(start, reserve, [bp]);
        const initialNet = state.status === 'forfeited' ? 0n : current.beneficiaries[0]!.net_fen;
        current = {
          ...current,
          event: 'clawback',
          platform_net_fen: start - initialNet,
          beneficiaries: [beneficiary({ ...state, ratio_bp: bp, net_fen: initialNet })],
        };
        let valid = true;
        for (const factor of [...factors, 0n]) {
          const next = (current.booked_n_fen * factor) / 10000n;
          const result = planCommissionAdjustment({ ...current, n_new_fen: next });
          const row = result.beneficiaries[0]!;
          const expected =
            state.status === 'forfeited'
              ? 0n
              : (((next * (10000n - reserve)) / 10000n) * bp) / 10000n;
          valid &&=
            row.net_after_fen === expected &&
            row.net_after_fen >= 0n &&
            row.delta_fen <= 0n &&
            current.beneficiaries[0]!.net_fen + row.delta_fen === row.net_after_fen &&
            result.union_receivable_delta_fen === next - current.booked_n_fen &&
            (row.delta_fen === 0n
              ? row.posting === null
              : row.posting ===
                (state.deletion_status === 'processing' || state.deletion_status === 'done'
                  ? 'bad_debt'
                  : 'user_available'));
          current = {
            ...current,
            ...result.booked_after,
            platform_net_fen: result.platform_after_fen,
            beneficiaries: [{ ...current.beneficiaries[0]!, net_fen: row.net_after_fen }],
          };
          if (result.rebate_status === 'CLAWED_BACK') break;
        }
        return valid && current.beneficiaries[0]!.net_fen === 0n;
      },
    ),
    params,
  );
  const record = stats.flush();
  expect({
    runs: Object.values(record.hits).reduce((sum, count) => sum + count, 0),
    discards: record.discards,
  }).toEqual({ runs: params.numRuns, discards: 0 });
}, 120_000);

it('[AC-B2-04g#38] BR-FUND-08/09：暂缓义务变化后全部凭证净影响等于 ΔN−Δ待补记', () => {
  const params = propParams();
  const stats = createPropStats('B2-04g:receivable-conservation');
  fc.assert(
    fc.property(
      positiveN,
      positiveN,
      reserveBp,
      fc.bigInt({ min: 1n, max: 8000n }),
      fc.constantFrom('frozen', 'appealing', 'banned', 'normal'),
      (old, next, reserve, bp, risk_state) => {
        stats.hit(risk_state);
        const initial = baseline(old, reserve, [bp]);
        const pendingBefore = initial.beneficiaries[0]!.net_fen;
        const result = planCommissionAdjustment({
          ...initial,
          n_new_fen: next,
          beneficiaries: [
            {
              ...initial.beneficiaries[0]!,
              risk_state,
              net_fen: 0n,
              obligation: { beneficiary_credit_id: 'open-1', kind: 'first_credit' },
            },
          ],
        });
        const row = result.beneficiaries[0]!;
        const actual = row.delta_fen + result.platform_delta_fen;
        const expected = next - old - (row.pending_after_fen - pendingBefore);
        return (
          row.pending_before_fen === pendingBefore &&
          actual === expected &&
          result.union_receivable_delta_fen === expected &&
          result.booked_after.booked_n_fen === next &&
          row.net_after_fen >= 0n &&
          row.pending_after_fen >= 0n &&
          (result.route !== 'immediate' || row.delta_fen <= 0n) &&
          (result.route !== 'approval' || row.delta_fen >= 0n)
        );
      },
    ),
    params,
  );
  const record = stats.flush();
  expect({
    runs: Object.values(record.hits).reduce((sum, count) => sum + count, 0),
    discards: record.discards,
  }).toEqual({ runs: params.numRuns, discards: 0 });
}, 120_000);
