import { expect, it } from 'vitest';
import type { RuleRow } from '../../../../apps/api/src/modules/commission/domain/rules.ts';
import { APP, COMPARE, NORMAL, PLATFORMS, fixture, item, version, viewer } from './fixtures.ts';

it.each([
  { key: 'commission.platforms', platform: 'taobao' },
  { key: 'tech_fee_bp', platform: 'taobao' },
  { key: 'rebate.taobao.compare_rate_ratio_bp', platform: 'taobao' },
  { key: 'union.pdd.self_buy_factor_bp', platform: 'pdd' },
  { key: 'union.pdd.account_level_factor_bp', platform: 'pdd' },
] as const)('[AC-B2-03c#19] 缺少 $key 时拒绝报价，不填默认值', async ({ key, platform }) => {
  const f = fixture();
  f.values.delete(key);
  await expect(
    f.quoter.quote(item({ platform }), viewer(), platform === 'taobao' ? COMPARE : NORMAL),
  ).rejects.toThrow();
});

it.each([null, '5000', -1, 10001, 0.5, true, {}, [], Number.MAX_SAFE_INTEGER])(
  '[AC-B2-03c#20] 非整数万分比配置 %j 被拒绝',
  async (invalid) => {
    const f = fixture();
    for (const key of [
      'rebate.taobao.compare_rate_ratio_bp',
      'union.pdd.self_buy_factor_bp',
      'union.pdd.account_level_factor_bp',
    ] as const) {
      const previous = f.values.get(key)!;
      f.values.set(key, invalid);
      const pdd = key.startsWith('union.pdd.');
      await expect(
        f.quoter.quote(
          item({ platform: pdd ? 'pdd' : 'taobao' }),
          viewer(),
          pdd ? NORMAL : COMPARE,
        ),
      ).rejects.toThrow();
      f.values.set(key, previous);
    }
  },
);

it.each([
  null,
  1000,
  [],
  {},
  { jd: 0 },
  { taobao: '1000' },
  { taobao: -1 },
  { taobao: 10001 },
  { taobao: 0.5 },
])('[AC-B2-03c#21] tech_fee_bp 格式错或缺目标平台 %j 即拒绝', async (invalid) => {
  const f = fixture();
  f.values.set('tech_fee_bp', invalid);
  await expect(f.quoter.quote(item(), viewer(), NORMAL)).rejects.toThrow();
});

it.each([null, 'taobao', {}, [], ['jd'], ['taobao', 1], ['taobao', 'unknown']])(
  '[AC-B2-03c#22] commission.platforms 错误或不含当前平台 %j 即拒绝',
  async (invalid) => {
    const f = fixture();
    f.values.set('commission.platforms', invalid);
    await expect(f.quoter.quote(item(), viewer(), NORMAL)).rejects.toThrow();
  },
);

it.each(['jd', 'pdd'] as const)(
  '[AC-B2-03c#23] BR-PRICE-07 $0 不允许比价区间',
  async (platform) => {
    const f = fixture();
    await expect(f.quoter.quote(item({ platform }), viewer(), COMPARE)).rejects.toThrow(TypeError);
  },
);

it.each(['missing', 'error'] as const)(
  '[AC-B2-03c#24] 登录用户等级 $0 不回退游客 L1',
  async (state) => {
    const f = fixture();
    if (state === 'error') f.levelOf.mockRejectedValue(new Error('synthetic level storage outage'));
    await expect(
      f.quoter.quote(item(), viewer({ userId: 'unknown-user' }), NORMAL),
    ).rejects.toThrow();
    expect(f.levelOf).toHaveBeenCalledWith({ appId: APP, userId: 'unknown-user' });
  },
);

it.each(['rules', 'config'] as const)(
  '[AC-B2-03c#25] $0 端口异常使报价失败，不变成零返利',
  async (port) => {
    const f = fixture();
    if (port === 'rules')
      f.publishedVersions.mockRejectedValue(new Error('synthetic rules outage'));
    else f.configValue.mockRejectedValue(new Error('synthetic config outage'));
    await expect(f.quoter.quote(item(), viewer(), NORMAL)).rejects.toThrow();
  },
);

it.each(['r_own_bp', 'r_direct_bp', 'r_indirect_bp'] as const)(
  '[AC-B2-03c#26] BR-CALC-06 选中版本各行必填比例 $0 缺失即拒绝',
  async (field) => {
    const f = fixture();
    const rules = version().rules.map((r) => {
      const malformed: { -readonly [K in keyof RuleRow]?: RuleRow[K] } = { ...r };
      if (r.platform === 'jd' && r.level === 'L3' && r.order_type === 'share')
        delete malformed[field];
      return malformed as RuleRow;
    });
    f.versions.set(APP, [version({ rules })]);
    await expect(f.quoter.quote(item(), viewer(), NORMAL)).rejects.toThrow();
  },
);

it.each([-1, 10001, 0.5, NaN])(
  '[AC-B2-03c#27] 不合法预留 %s 拒绝而非夹到边界',
  async (reserve_bp) => {
    const f = fixture();
    f.versions.set(APP, [
      version({ reserves: PLATFORMS.map((platform) => ({ platform, reserve_bp })) }),
    ]);
    await expect(f.quoter.quote(item(), viewer(), NORMAL)).rejects.toThrow();
  },
);
