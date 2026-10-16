import type { CommissionBeneficiary, SplitCommissionInput } from '@couli/domain';
import { createPropStats, propParams } from '@couli/testing';
import type { PropStatsRecord } from '@couli/testing';
import fc from 'fast-check';
import { amountFen, bucketOf, ratioBp, signedFen } from '../../money/arb.ts';

export { amountFen, ratioBp };

export const FULL_COVERAGE = {
  zero: true,
  one: true,
  odd: true,
  gt_2_31: true,
  no_discards: true,
};

const status = fc.constantFrom<CommissionBeneficiary['status']>('active', 'forfeited');

// 三个独立角色比例，由排序切点得到总和≤8000的合法发布范围；无filter或fc.pre。
const ratios = fc
  .tuple(
    fc.bigInt({ min: 0n, max: 8000n }),
    fc.bigInt({ min: 0n, max: 8000n }),
    fc.bigInt({ min: 0n, max: 8000n }),
  )
  .map(([a, b, c]) => {
    const low = a < b ? (a < c ? a : c) : b < c ? b : c;
    const high = a > b ? (a > c ? a : c) : b > c ? b : c;
    const middle = a + b + c - low - high;
    return [low, middle - low, high - middle] as const;
  });

export const commissionInput: fc.Arbitrary<SplitCommissionInput> = fc
  .record({
    n: signedFen,
    reserve: ratioBp,
    tlj: fc.oneof(fc.constant(0n), amountFen),
    order: fc.constantFrom<'self' | 'share'>('self', 'share'),
    enabled: fc.boolean(),
    ratios,
    hasDirect: fc.boolean(),
    hasIndirect: fc.boolean(),
    ownerStatus: status,
    directStatus: status,
    indirectStatus: status,
    indirectId: fc.constantFrom('grandparent', 'owner', 'parent'),
  })
  .map((v) => ({
    n_base_fen: v.n,
    reserve_bp: v.reserve,
    tlj_deduct_fen: v.tlj,
    order_type: v.order,
    indirect_enabled: v.enabled,
    owner: { user_id: 'owner', ratio_bp: v.ratios[0], status: v.ownerStatus },
    direct: v.hasDirect
      ? { user_id: 'parent', ratio_bp: v.ratios[1], status: v.directStatus }
      : null,
    indirect: v.hasIndirect
      ? { user_id: v.indirectId, ratio_bp: v.ratios[2], status: v.indirectStatus }
      : null,
  }));

/** 每条属性写覆盖统计；次数和种子只有propParams一个入口。 */
export function checkProperty<T>(
  name: string,
  arbitrary: fc.Arbitrary<T>,
  amount: (value: T) => bigint,
  predicate: (value: T) => boolean,
): Record<string, boolean> {
  const stats = createPropStats(`domain:commission:${name}`);
  let record: PropStatsRecord;
  try {
    fc.assert(
      fc.property(arbitrary, (value) => {
        stats.hit(bucketOf(amount(value)));
        return predicate(value);
      }),
      propParams(),
    );
  } finally {
    record = stats.flush();
  }
  // 沿用资金测试的四档各≥1%要求；小于1000次时不作统计门槛。
  const enough = (bucket: string): boolean =>
    record.num_runs < 1000 || (record.hits[bucket] ?? 0) >= record.num_runs / 100;
  return {
    zero: enough('zero'),
    one: enough('one'),
    odd: enough('odd'),
    gt_2_31: enough('gt_2_31'),
    no_discards: record.discards === 0,
  };
}
