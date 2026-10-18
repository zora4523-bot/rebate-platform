import { expect, it } from 'vitest';
import {
  TrialComputationError,
  buildTrialReport,
  needsIndirectPerson,
  peopleOfSnapshot,
  sampleDigest,
  shiftMs,
  toChinaIso,
  wholeSeconds,
  withResolvedIndirect,
  type DigestAmount,
  type DigestSplit,
  type TrialSample,
} from './rule-trial.ts';
import type { RuleVersion } from './rules.ts';

const PLATFORMS = ['taobao', 'jd', 'pdd'] as const;

function version(
  ratios: { own: number; direct: number; indirect: number },
  reserveBp: number,
  indirectEnabled = true,
): RuleVersion {
  return {
    rule_version_id: 'v',
    effective_from: new Date('2030-06-01T00:00:00+08:00'),
    indirect_enabled: indirectEnabled,
    rules: PLATFORMS.flatMap((platform) =>
      (['L1', 'L2', 'L3'] as const).flatMap((level) =>
        (['self', 'share'] as const).map((order_type) => ({
          platform,
          level,
          order_type,
          r_own_bp: ratios.own,
          r_direct_bp: level === 'L2' ? ratios.direct : 100,
          r_indirect_bp: level === 'L3' ? ratios.indirect : 100,
        })),
      ),
    ),
    reserves: PLATFORMS.map((platform) => ({ platform, reserve_bp: reserveBp })),
  };
}

function sample(extra: Partial<TrialSample> = {}): TrialSample {
  return {
    orderId: 'o1',
    platform: 'taobao',
    orderType: 'self',
    rebateMode: null,
    rawNFen: 1234n,
    subsidyCommissionFen: 0n,
    tljDeductFen: 0n,
    owner: { userId: 'u1', level: 'L1', status: 'active', forfeitReason: null },
    direct: { userId: 'u2', level: 'L2', status: 'active', forfeitReason: null },
    indirect: { userId: 'u3', level: 'L3', status: 'active', forfeitReason: null },
    ...extra,
  };
}

it('[AC-B2-03k-UNIT#1] 时刻按 +08:00 输出且保留毫秒，按整秒比较，移动不改原值', () => {
  const at = new Date('2030-06-12T12:00:00.999+08:00');
  expect(toChinaIso(at)).toBe('2030-06-12T12:00:00.999+08:00');
  expect(wholeSeconds(at)).toBe(wholeSeconds(new Date('2030-06-12T12:00:00.001+08:00')));
  const earlier = shiftMs(at, -7 * 86_400_000);
  expect(toChinaIso(earlier)).toBe('2030-06-05T12:00:00.999+08:00');
  expect(toChinaIso(at)).toBe('2030-06-12T12:00:00.999+08:00');
  expect(() => toChinaIso(new Date(Number.NaN))).toThrow(TypeError);
});

it('[AC-B2-03k-UNIT#2] 试算按各角色等级重算现行与草稿列，空平台为零，无基准时现行为 null', () => {
  const current = version({ own: 5000, direct: 1000, indirect: 500 }, 1000);
  const draft = version({ own: 4500, direct: 1200, indirect: 700 }, 2000);
  const rows = buildTrialReport({
    platforms: [...PLATFORMS, 'taobao'],
    current,
    draft,
    samples: [sample()],
  });
  expect(rows.map((r) => r.platform)).toEqual(['taobao', 'jd', 'pdd']);
  expect(rows[0]).toEqual({
    platform: 'taobao',
    // owner L1 → own 5000 / direct L2 → 1000 / indirect L3 → 500 (rest of the rows 100).
    current: {
      reserveBp: 1000,
      reserveFen: 124,
      ownFen: 555,
      directFen: 111,
      indirectFen: 55,
      platformRetainFen: 389,
    },
    draft: {
      reserveBp: 2000,
      reserveFen: 247,
      ownFen: 444,
      directFen: 118,
      indirectFen: 69,
      platformRetainFen: 356,
    },
  });
  expect(rows[2]?.draft).toEqual({
    reserveBp: 2000,
    reserveFen: 0,
    ownFen: 0,
    directFen: 0,
    indirectFen: 0,
    platformRetainFen: 0,
  });
  const first = buildTrialReport({ platforms: PLATFORMS, current: null, draft, samples: [] });
  expect(first.every((r) => r.current === null)).toBe(true);
});

it('[AC-B2-03k-UNIT#3] 关闭间推的草稿间推列为 0，份额留给平台', () => {
  const draft = version({ own: 5000, direct: 1000, indirect: 0 }, 1000, false);
  const [taobao] = buildTrialReport({
    platforms: PLATFORMS,
    current: null,
    draft,
    samples: [sample()],
  });
  expect(taobao?.draft).toMatchObject({ indirectFen: 0, ownFen: 555, platformRetainFen: 444 });
});

it('[AC-B2-03k-UNIT#4] 超出 JSON 安全整数、未配置平台或缺行都抛错，不生成报告', () => {
  const draft = version({ own: 5000, direct: 1000, indirect: 500 }, 1000);
  expect(() =>
    buildTrialReport({
      platforms: PLATFORMS,
      current: null,
      draft,
      samples: [sample({ rawNFen: 9223372036854775807n })],
    }),
  ).toThrow();
  expect(() =>
    buildTrialReport({
      platforms: PLATFORMS,
      current: null,
      draft,
      samples: [sample({ platform: 'meituan' })],
    }),
  ).toThrow(TrialComputationError);
  const partial: RuleVersion = { ...draft, rules: draft.rules.filter((r) => r.level !== 'L3') };
  expect(() =>
    buildTrialReport({ platforms: PLATFORMS, current: null, draft: partial, samples: [sample()] }),
  ).toThrow(TrialComputationError);
});

const split: DigestSplit = {
  orderId: 'o1',
  platform: 'taobao',
  ruleVersionId: 'v',
  orderType: 'self',
  activityType: null,
  rebateMode: null,
  paidAtMs: 1,
  paidAtSource: 'platform',
  rawNFen: 1234n,
  subsidyCommissionFen: 0n,
  reserveBp: 1000,
  reserveFen: 124n,
  tljDeductFen: 0n,
  baseFen: 1110n,
  platformRetainFen: 389n,
  beneficiaries: [{ role: 'self', user_id: 'u1' }],
};
const amount: DigestAmount = {
  orderId: 'o1',
  commissionVersion: 1,
  userId: 'u1',
  role: 'self',
  baseFen: 1110n,
  amountFen: 555n,
};

it('[AC-B2-03k-UNIT#5] 样本摘要与输入顺序无关，新增金额版本或换窗口即变化', () => {
  const other: DigestSplit = { ...split, orderId: 'o0' };
  const base = sampleDigest({ fromMs: 0, toMs: 10, splits: [split, other], amounts: [amount] });
  expect(sampleDigest({ fromMs: 0, toMs: 10, splits: [other, split], amounts: [amount] })).toBe(
    base,
  );
  expect(base).toMatch(/^[0-9a-f]{64}$/);
  expect(
    sampleDigest({
      fromMs: 0,
      toMs: 10,
      splits: [split, other],
      amounts: [amount, { ...amount, commissionVersion: 2, amountFen: 1n }],
    }),
  ).not.toBe(base);
  expect(sampleDigest({ fromMs: 1, toMs: 10, splits: [split, other], amounts: [amount] })).not.toBe(
    base,
  );
});

it('[AC-B2-03k-UNIT#6] 快照受益人按角色读回，缺本人或数据非法抛错', () => {
  const people = peopleOfSnapshot([
    { user_id: 'u1', role: 'share', level: 'L1', initial_status: 'active', forfeit_reason: null },
    {
      user_id: 'u2',
      role: 'direct',
      level: 'L2',
      initial_status: 'forfeited',
      forfeit_reason: 'banned',
    },
  ]);
  expect(people).toEqual({
    owner: { userId: 'u1', level: 'L1', status: 'active', forfeitReason: null },
    direct: { userId: 'u2', level: 'L2', status: 'forfeited', forfeitReason: 'banned' },
    indirect: null,
  });
  expect(() => peopleOfSnapshot([])).toThrow(TrialComputationError);
  expect(() =>
    peopleOfSnapshot([{ user_id: 'u1', role: 'self', level: 'L9', initial_status: 'active' }]),
  ).toThrow(TrialComputationError);
  expect(() => peopleOfSnapshot({})).toThrow(TrialComputationError);
});

it('[AC-B2-03k-UNIT#13] 只有比较版本开间推、快照有直推人却无间推人时才需要补间推人', () => {
  const on = version({ own: 5000, direct: 1000, indirect: 500 }, 0, true);
  const off = version({ own: 5000, direct: 1000, indirect: 0 }, 0, false);
  const missing = sample({ indirect: null });
  expect(needsIndirectPerson(missing, [off, on])).toBe(true);
  expect(needsIndirectPerson(missing, [on, off])).toBe(true);
  expect(needsIndirectPerson(missing, [null, on])).toBe(true);
  expect(needsIndirectPerson(missing, [off, off])).toBe(false);
  expect(needsIndirectPerson(sample(), [off, on])).toBe(false);
  expect(needsIndirectPerson(sample({ direct: null, indirect: null }), [on])).toBe(false);
});

it('[AC-B2-03k-UNIT#14] 补出的间推人参与草稿重算；解析结果与快照不符或格式不对即抛错', () => {
  const missing = sample({ indirect: null, rawNFen: 1000n });
  const owner = missing.owner;
  const direct = missing.direct!;
  const grand = { userId: 'u3', level: 'L3', status: 'active', forfeitReason: null } as const;
  const filled = withResolvedIndirect(missing, { owner, direct, indirect: grand });
  expect(filled.indirect).toEqual(grand);
  expect(withResolvedIndirect(missing, { owner, direct, indirect: null }).indirect).toBeNull();
  const [row] = buildTrialReport({
    platforms: ['taobao'],
    current: null,
    draft: version({ own: 5000, direct: 1000, indirect: 500 }, 0, true),
    samples: [filled],
  });
  expect(row?.draft.indirectFen).toBe(50);
  for (const bad of [
    { owner: { ...owner, userId: 'x' }, direct, indirect: grand },
    { owner, direct: { ...direct, userId: 'x' }, indirect: grand },
    { owner, direct: { ...direct, level: 'L1' }, indirect: grand },
    { owner, direct: { ...direct, status: 'forfeited' }, indirect: grand },
    { owner, direct: null, indirect: grand },
    { owner, direct, indirect: undefined },
    { owner, direct, indirect: { ...grand, level: 'L9' } },
    { owner, direct, indirect: { ...grand, userId: '' } },
  ]) {
    expect(() => withResolvedIndirect(missing, bad)).toThrow(TrialComputationError);
  }
  expect(() =>
    withResolvedIndirect(sample({ direct: null, indirect: null }), {
      owner,
      direct,
      indirect: grand,
    }),
  ).toThrow(TrialComputationError);
});
