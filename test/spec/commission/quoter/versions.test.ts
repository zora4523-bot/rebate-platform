import { expect, it } from 'vitest';
import {
  APP,
  NORMAL,
  NOW,
  PLATFORMS,
  fixture,
  item,
  version,
  viewer,
  commission,
} from './fixtures.ts';

const { selectRuleVersion, selectQuoteTerms } = commission;

function newer() {
  return version({
    rule_version_id: '00000000-0000-4000-8000-000000000002',
    effective_from: new Date(NOW),
    rules: version().rules.map((r) => ({ ...r, r_own_bp: 4000 })),
    reserves: PLATFORMS.map((platform) => ({ platform, reserve_bp: 2000 })),
  });
}

it.each([
  { at: '2026-10-31T23:59:59+08:00', expected: 500n },
  { at: NOW, expected: 320n },
  { at: '2026-10-31T16:00:00Z', expected: 320n },
  { at: '2026-11-01T00:00:01+08:00', expected: 320n },
])(
  '[AC-B2-03c#11] BR-CALC-11 报价时刻 $at 边界含等号、同一时刻跨时区等价',
  async ({ at, expected }) => {
    const f = fixture();
    // Unsorted, plus a future published version; quoted_at deliberately stays in October.
    f.versions.set(APP, [
      newer(),
      version({ rule_version_id: 'future', effective_from: new Date('2026-12-01T00:00:00+08:00') }),
      version(),
    ]);
    f.clock.set(at);
    expect((await f.quoter.quote(item(), viewer(), NORMAL)).rebateMaxFen).toBe(expected);
    expect(f.publishedVersions.mock.calls).toEqual([[APP]]);
  },
);

it('[AC-B2-03c#12] BR-CALC-11 到秒比较，两边毫秒不改变同秒生效边界', () => {
  const next = { ...newer(), effective_from: new Date('2026-11-01T00:00:00.900+08:00') };
  expect(
    selectRuleVersion([next, version()], new Date('2026-11-01T00:00:00.100+08:00')).rule_version_id,
  ).toBe(next.rule_version_id);
  expect(
    selectRuleVersion([next, version()], new Date('2026-10-31T23:59:59.999+08:00')).rule_version_id,
  ).toBe(version().rule_version_id);
});

it('[AC-B2-03c#13] BR-CALC-11 纯选择函数取最大有效时刻，不依赖数组排列', () => {
  const old = version();
  const next = newer();
  const future = version({
    rule_version_id: 'future',
    effective_from: new Date('2026-12-01T00:00:00+08:00'),
  });
  for (const list of [
    [old, future, next],
    [next, old, future],
    [future, next, old],
  ]) {
    expect(selectRuleVersion(list, new Date(NOW))).toEqual(next);
    expect(list).toHaveLength(3);
  }
});

it.each(['empty', 'future-only'] as const)(
  '[AC-B2-03c#14] 报价没有可用版本（$0）即失败，不套订单早于首版的兜底',
  async (state) => {
    const f = fixture();
    f.versions.set(
      APP,
      state === 'empty' ? [] : [version({ effective_from: new Date('2026-12-01T00:00:00+08:00') })],
    );
    await expect(f.quoter.quote(item(), viewer(), NORMAL)).rejects.toThrow();
  },
);

it('[AC-B2-03c#15] BR-CALC-11/20 同一报价器跨生效边界重新选择比例与预留，不修改旧报价', async () => {
  const f = fixture();
  f.versions.set(APP, [newer(), version()]);
  f.clock.set('2026-10-31T23:59:59+08:00');
  const before = await f.quoter.quote(item(), viewer(), NORMAL);
  f.clock.advanceMs(1000);
  const after = await f.quoter.quote(item(), viewer(), NORMAL);
  expect(before.rebateMaxFen).toBe(500n);
  expect(after.rebateMaxFen).toBe(320n);
  expect(before.rebateMaxFen).toBe(500n);
});

it('[AC-B2-03c#16] BR-CALC-06 纯取值按 platform × level × order_type，不拿上级比例', () => {
  const selected = version({
    rules: version().rules.map((r) => ({
      ...r,
      r_own_bp: r.platform === 'jd' && r.level === 'L3' && r.order_type === 'share' ? 3456 : 1234,
      r_direct_bp: 1000,
    })),
    reserves: [
      { platform: 'taobao', reserve_bp: 100 },
      { platform: 'jd', reserve_bp: 2345 },
      { platform: 'pdd', reserve_bp: 300 },
    ],
  });
  expect(
    selectQuoteTerms({
      version: selected,
      platforms: PLATFORMS,
      platform: 'jd',
      level: 'L3',
      orderType: 'share',
    }),
  ).toEqual({ reserve_bp: 2345n, r_own_bp: 3456n });
});

it.each([
  { kind: 'requested-rule' },
  { kind: 'other-level' },
  { kind: 'other-order-type' },
  { kind: 'other-platform' },
  { kind: 'requested-reserve' },
  { kind: 'other-reserve' },
] as const)(
  '[AC-B2-03c#17] BR-CALC-06 最新版本缺 $kind，整个版本拒绝且不向旧版本借值',
  async ({ kind }) => {
    const f = fixture();
    const next = newer();
    const incomplete = {
      ...next,
      rules: next.rules.filter((r) => {
        if (kind === 'requested-rule')
          return !(r.platform === 'taobao' && r.level === 'L1' && r.order_type === 'self');
        if (kind === 'other-level')
          return !(r.platform === 'taobao' && r.level === 'L3' && r.order_type === 'self');
        if (kind === 'other-order-type')
          return !(r.platform === 'taobao' && r.level === 'L1' && r.order_type === 'share');
        if (kind === 'other-platform') return r.platform !== 'jd';
        return true;
      }),
      reserves: next.reserves.filter((r) =>
        kind === 'requested-reserve'
          ? r.platform !== 'taobao'
          : kind === 'other-reserve'
            ? r.platform !== 'jd'
            : true,
      ),
    };
    f.versions.set(APP, [version(), incomplete]);
    await expect(f.quoter.quote(item(), viewer(), NORMAL)).rejects.toThrow();
  },
);

it('[AC-B2-03c#18] BR-CALC-06 完整性按 commission.platforms 配置集合校验', async () => {
  const f = fixture();
  f.values.set('commission.platforms', ['jd']);
  f.versions.set(APP, [
    version({
      rules: version().rules.filter((r) => r.platform === 'jd'),
      reserves: [{ platform: 'jd', reserve_bp: 0 }],
    }),
  ]);
  expect((await f.quoter.quote(item({ platform: 'jd' }), viewer(), NORMAL)).rebateMaxFen).toBe(
    500n,
  );
});
