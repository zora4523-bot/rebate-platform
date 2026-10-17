import { expect, it } from 'vitest';
import type { RuleVersion } from './rules.ts';
import {
  planSnapshot,
  selectSnapshotRuleVersion,
  type PlanSnapshotInput,
  type SnapshotPeople,
} from './snapshot.ts';

function version(id: string, effective: string, extra: Partial<RuleVersion> = {}): RuleVersion {
  return {
    rule_version_id: id,
    effective_from: new Date(effective),
    indirect_enabled: true,
    rules: (['taobao', 'jd', 'pdd'] as const).flatMap((platform) =>
      (['L1', 'L2', 'L3'] as const).flatMap((level) =>
        (['self', 'share'] as const).map((order_type) => ({
          platform,
          level,
          order_type,
          r_own_bp: 5000,
          r_direct_bp: 1000,
          r_indirect_bp: 500,
        })),
      ),
    ),
    reserves: (['taobao', 'jd', 'pdd'] as const).map((platform) => ({ platform, reserve_bp: 0 })),
    ...extra,
  };
}

const people: SnapshotPeople = {
  owner: { userId: 'u-owner', level: 'L1', status: 'active', forfeitReason: null },
  direct: { userId: 'u-direct', level: 'L2', status: 'active', forfeitReason: null },
  indirect: { userId: 'u-indirect', level: 'L3', status: 'active', forfeitReason: null },
};

function plan(extra: Partial<PlanSnapshotInput> = {}) {
  return planSnapshot({
    version: version('v', '2026-10-01T00:00:00+08:00'),
    platform: 'taobao',
    orderType: 'self',
    rebateMode: null,
    nBaseFen: 1234n,
    subsidyCommissionFen: 0n,
    tljDeductFen: 0n,
    tljRedpacketFen: 0n,
    people,
    ...extra,
  });
}

it('[AC-B2-03g-UNIT#1] 选版：无版本 none；早于首版取最早并标记；首版同秒并列抛错', () => {
  expect(selectSnapshotRuleVersion([], new Date('2026-10-01T00:00:00Z')).kind).toBe('none');
  const a = version('a', '2026-10-01T00:00:00+08:00');
  const b = version('b', '2026-11-01T00:00:00+08:00');
  const early = selectSnapshotRuleVersion([b, a], new Date('2020-01-01T00:00:00+08:00'));
  expect(early).toEqual({ kind: 'chosen', version: a, beforeFirst: true });
  const normal = selectSnapshotRuleVersion([b, a], new Date('2026-11-01T00:00:00+08:00'));
  expect(normal).toEqual({ kind: 'chosen', version: b, beforeFirst: false });
  const tie = version('t', '2026-10-01T00:00:00.500+08:00');
  expect(() => selectSnapshotRuleVersion([a, tie], new Date('2020-01-01T00:00:00Z'))).toThrow();
  expect(() => selectSnapshotRuleVersion([a], new Date('bad'))).toThrow(TypeError);
});

it('[AC-B2-03g-UNIT#2] 分账：比例取所选版本 (平台, 等级, 订单类型)，四段金额等式成立', () => {
  const result = plan();
  expect(result.kind).toBe('plan');
  if (result.kind !== 'plan') return;
  expect(result.beneficiaries.map((b) => [b.role, b.ratio_bp, b.amount_fen, b.level])).toEqual([
    ['self', 5000n, 617n, 'L1'],
    ['direct', 1000n, 123n, 'L2'],
    ['indirect', 500n, 61n, 'L3'],
  ]);
  expect(result.user_share_total_fen).toBe(801n);
  expect(result.platform_retain_fen).toBe(433n);
  expect(result.pre_base_deduct_fen).toBe(result.n_total_fen - result.base_fen);
  expect(result.platform_est_profit_fen).toBe(433n);
  expect(result.warnings).toEqual([]);
});

it('[AC-B2-03g-UNIT#3] 缺预留或参与者的规则行返回 pending；关间推时不要求间推行', () => {
  const v = version('v', '2026-10-01T00:00:00+08:00');
  expect(plan({ version: { ...v, reserves: [] } }).kind).toBe('pending');
  const noL3 = { ...v, rules: v.rules.filter((r) => r.level !== 'L3') };
  expect(plan({ version: noL3 }).kind).toBe('pending');
  const off = plan({ version: { ...noL3, indirect_enabled: false } });
  expect(off.kind).toBe('plan');
  if (off.kind === 'plan') expect(off.beneficiaries.map((b) => b.role)).toEqual(['self', 'direct']);
});

it('[AC-B2-03g-UNIT#4] rebate_mode none 全部份额 0；淘礼金未匹配红包与利润同为 null 并告警', () => {
  const none = plan({ rebateMode: 'none', nBaseFen: 500n, tljRedpacketFen: 300n });
  expect(none.kind === 'plan' && none.beneficiaries.map((b) => b.amount_fen)).toEqual([0n, 0n, 0n]);
  expect(none.kind === 'plan' && none.platform_est_profit_fen).toBe(200n);
  const unmatched = plan({ rebateMode: 'normal', tljRedpacketFen: null });
  expect(unmatched.kind === 'plan' && unmatched.tlj_redpacket_fen).toBeNull();
  expect(unmatched.kind === 'plan' && unmatched.platform_est_profit_fen).toBeNull();
  expect(unmatched.kind === 'plan' && unmatched.warnings).toContain('TLJ_REDPACKET_UNMATCHED');
  const plain = plan({ tljRedpacketFen: null });
  expect(plain.kind === 'plan' && plain.tlj_redpacket_fen).toBe(0n);
});

it('[AC-B2-03g-UNIT#5] 非 normal 模式带淘礼金扣除、非 bigint 金额、非法等级都抛错', () => {
  expect(() => plan({ tljDeductFen: 1n })).toThrow(RangeError);
  expect(() => plan({ nBaseFen: 1 as unknown as bigint })).toThrow(TypeError);
  expect(() =>
    plan({ people: { ...people, owner: { ...people.owner, level: 'L9' as 'L1' } } }),
  ).toThrow(TypeError);
});

it('[AC-B2-03g-UNIT#6] forfeited 份额 0 归平台并保留原因；无直推时不输出间推', () => {
  const forfeited = plan({
    people: {
      ...people,
      direct: { ...people.direct!, status: 'forfeited', forfeitReason: 'deleted' },
    },
  });
  expect(forfeited.kind).toBe('plan');
  if (forfeited.kind !== 'plan') return;
  const direct = forfeited.beneficiaries.find((b) => b.role === 'direct');
  expect(direct).toMatchObject({
    amount_fen: 0n,
    initial_status: 'forfeited',
    forfeit_reason: 'deleted',
  });
  expect(forfeited.platform_retain_fen).toBe(1234n - 617n - 61n);
  const noDirect = plan({ people: { ...people, direct: null } });
  expect(noDirect.kind === 'plan' && noDirect.beneficiaries.map((b) => b.role)).toEqual(['self']);
});
