import { expect, it } from 'vitest';
import { selectQuoteTerms, selectRuleVersion, type RuleVersion } from './rules.ts';

const PLATFORMS = ['taobao', 'jd', 'pdd'] as const;

function version(id: string, effective: string, extra: Partial<RuleVersion> = {}): RuleVersion {
  return {
    rule_version_id: id,
    effective_from: new Date(effective),
    indirect_enabled: false,
    rules: PLATFORMS.flatMap((platform) =>
      (['L1', 'L2', 'L3'] as const).flatMap((level) =>
        (['self', 'share'] as const).map((order_type) => ({
          platform,
          level,
          order_type,
          r_own_bp: 5000,
          r_direct_bp: 1000,
          r_indirect_bp: 0,
        })),
      ),
    ),
    reserves: PLATFORMS.map((platform) => ({ platform, reserve_bp: 0 })),
    ...extra,
  };
}

it('[AC-B2-03c-UNIT#1] 同一秒生效的两个版本同时可选时拒绝，不随数组顺序取一个', () => {
  const a = version('a', '2026-10-01T00:00:00.100+08:00');
  const b = version('b', '2026-10-01T00:00:00.900+08:00');
  expect(() => selectRuleVersion([a, b], new Date('2026-10-02T00:00:00+08:00'))).toThrow();
  // A newer version above the tie resolves it.
  const c = version('c', '2026-10-01T12:00:00+08:00');
  expect(selectRuleVersion([a, c, b], new Date('2026-10-02T00:00:00+08:00')).rule_version_id).toBe(
    'c',
  );
});

it('[AC-B2-03c-UNIT#2] 无效生效时间或报价时刻抛错', () => {
  const bad = version('bad', 'not a date');
  expect(() => selectRuleVersion([bad], new Date('2026-10-02T00:00:00+08:00'))).toThrow(TypeError);
  expect(() =>
    selectRuleVersion([version('a', '2026-10-01T00:00:00+08:00')], new Date('x')),
  ).toThrow(TypeError);
});

it('[AC-B2-03c-UNIT#3] 未配置平台的行不参与矩阵；重复行、超上限、关间推却有间推比例都拒绝', () => {
  const base = version('v', '2026-10-01T00:00:00+08:00');
  const withExtra = {
    ...base,
    rules: [
      ...base.rules,
      {
        platform: 'meituan' as const,
        level: 'L1' as const,
        order_type: 'self' as const,
        r_own_bp: 9999,
        r_direct_bp: 0,
        r_indirect_bp: 0,
      },
    ],
  };
  const input = { platforms: PLATFORMS, platform: 'jd', level: 'L2', orderType: 'self' } as const;
  expect(selectQuoteTerms({ ...input, version: withExtra })).toEqual({
    reserve_bp: 0n,
    r_own_bp: 5000n,
  });
  const duplicate = { ...base, rules: [...base.rules, base.rules[0]!] };
  expect(() => selectQuoteTerms({ ...input, version: duplicate })).toThrow();
  const overCap = { ...base, rules: base.rules.map((r) => ({ ...r, r_own_bp: 7500 })) };
  expect(() => selectQuoteTerms({ ...input, version: overCap })).toThrow();
  const indirectOff = { ...base, rules: base.rules.map((r) => ({ ...r, r_indirect_bp: 100 })) };
  expect(() => selectQuoteTerms({ ...input, version: indirectOff })).toThrow();
  expect(() => selectQuoteTerms({ ...input, platform: 'meituan', version: base })).toThrow();
});
