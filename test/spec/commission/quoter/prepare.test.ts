import { expect, it } from 'vitest';
import {
  APP,
  OTHER_APP,
  COMPARE,
  CONFIG_KEYS,
  NORMAL,
  NOW,
  fixture,
  item,
  version,
  viewer,
  commission,
} from './fixtures.ts';

it('[AC-B2-03c#28] 普通报价逐次读取当前 app 配置、等级与版本，不跨请求缓存', async () => {
  const f = fixture();
  const who = viewer({ userId: 'viewer-l2' });
  expect((await f.quoter.quote(item(), who, COMPARE)).rebateMinFen).toBe(275n);
  f.configValue.mockClear();
  f.levelOf.mockClear();
  f.publishedVersions.mockClear();
  f.values.set('rebate.taobao.compare_rate_ratio_bp', 2500);
  f.values.set('tech_fee_bp', { taobao: 1000, jd: 0, pdd: 0 });
  f.userLevels.set(`${APP}/viewer-l2`, 'L3');
  expect(await f.quoter.quote(item(), who, COMPARE)).toEqual({
    rebateMinFen: 135n,
    rebateMaxFen: 540n,
    estNetPriceFen: 9865n,
    rebateBasis: 'price_compare_risk',
  });
  expect(f.configValue).toHaveBeenCalledWith(APP, 'commission.platforms');
  expect(f.configValue).toHaveBeenCalledWith(APP, 'tech_fee_bp');
  expect(f.configValue).toHaveBeenCalledWith(APP, 'rebate.taobao.compare_rate_ratio_bp');
  expect(f.publishedVersions.mock.calls).toEqual([[APP]]);
  expect(f.levelOf.mock.calls).toEqual([[{ appId: APP, userId: 'viewer-l2' }]]);
  // A subsequently unreadable key must not reuse the last successful value.
  f.values.delete('tech_fee_bp');
  await expect(f.quoter.quote(item(), who, NORMAL)).rejects.toThrow();
});

it('[AC-B2-03c#29] 同 userId 跨 app 的规则、等级、配置必须分别读取', async () => {
  const f = fixture();
  f.versions.set(OTHER_APP, [
    version({
      reserves: [
        { platform: 'taobao', reserve_bp: 2000 },
        { platform: 'jd', reserve_bp: 0 },
        { platform: 'pdd', reserve_bp: 0 },
      ],
    }),
  ]);
  f.configByApp.set(OTHER_APP, new Map(f.values));
  f.configByApp.get(OTHER_APP)!.set('tech_fee_bp', { taobao: 1000, jd: 0, pdd: 0 });
  f.userLevels.set(`${OTHER_APP}/viewer-l2`, 'L3');
  const a = await f.quoter.quote(item(), viewer({ userId: 'viewer-l2' }), NORMAL);
  const b = await f.quoter.quote(item(), viewer({ appId: OTHER_APP, userId: 'viewer-l2' }), NORMAL);
  expect(a.rebateMaxFen).toBe(550n);
  expect(b.rebateMaxFen).toBe(432n);
  expect(f.publishedVersions.mock.calls).toEqual([[APP], [OTHER_APP]]);
  expect(f.levelOf).toHaveBeenCalledWith({ appId: OTHER_APP, userId: 'viewer-l2' });
  expect(f.configValue).toHaveBeenCalledWith(OTHER_APP, 'tech_fee_bp');
});

it('[AC-B2-03c#30] prepare 导出完整预读键清单，三平台多查看者报价不再访问端口', async () => {
  const f = fixture();
  // Test-stage skeleton exports the tuple type only; implementation must supply this value.
  const exports: Record<string, unknown> = commission;
  expect(exports['COMMISSION_QUOTE_CONFIG_KEYS']).toEqual(CONFIG_KEYS);
  await f.quoter.prepare(APP, ['viewer-l2', 'viewer-l3']);
  expect(f.publishedVersions).toHaveBeenCalledWith(APP);
  expect(f.levelOf).toHaveBeenCalledWith({ appId: APP, userId: 'viewer-l2' });
  expect(f.levelOf).toHaveBeenCalledWith({ appId: APP, userId: 'viewer-l3' });
  for (const key of CONFIG_KEYS) expect(f.configValue).toHaveBeenCalledWith(APP, key);
  const counts = [
    f.publishedVersions.mock.calls.length,
    f.levelOf.mock.calls.length,
    f.configValue.mock.calls.length,
  ];
  f.publishedVersions.mockRejectedValue(new Error('no port reads inside transaction'));
  f.levelOf.mockRejectedValue(new Error('no port reads inside transaction'));
  f.configValue.mockRejectedValue(new Error('no port reads inside transaction'));
  expect(
    (await f.quoter.quote(item(), viewer({ userId: 'viewer-l2' }), COMPARE)).rebateMaxFen,
  ).toBe(550n);
  expect(
    (await f.quoter.quote(item({ platform: 'jd' }), viewer({ userId: 'viewer-l3' }), NORMAL))
      .rebateMaxFen,
  ).toBe(600n);
  expect((await f.quoter.quote(item({ platform: 'pdd' }), viewer(), NORMAL)).rebateMaxFen).toBe(
    375n,
  );
  expect([
    f.publishedVersions.mock.calls.length,
    f.levelOf.mock.calls.length,
    f.configValue.mock.calls.length,
  ]).toEqual(counts);
});

it('[AC-B2-03c#31] prepare 预读全部版本，跨生效时刻仍在内存按当前 Clock 选新版本', async () => {
  const f = fixture();
  f.clock.set('2026-10-31T23:59:59+08:00');
  f.versions.set(APP, [
    version(),
    version({
      rule_version_id: 'next',
      effective_from: new Date(NOW),
      rules: version().rules.map((r) => ({ ...r, r_own_bp: 4000 })),
    }),
  ]);
  await f.quoter.prepare(APP, []);
  f.publishedVersions.mockClear();
  f.configValue.mockClear();
  f.levelOf.mockClear();
  expect((await f.quoter.quote(item(), viewer(), NORMAL)).rebateMaxFen).toBe(500n);
  f.clock.advanceMs(1000);
  expect((await f.quoter.quote(item(), viewer(), NORMAL)).rebateMaxFen).toBe(400n);
  expect(f.publishedVersions).not.toHaveBeenCalled();
  expect(f.configValue).not.toHaveBeenCalled();
  expect(f.levelOf).not.toHaveBeenCalled();
});

it.each([
  { appId: APP, userId: 'not-prepared' },
  { appId: OTHER_APP, userId: 'viewer-l2' },
  { appId: OTHER_APP, userId: null },
])('[AC-B2-03c#32] 预读作用域外 $appId/$userId 拒绝报价且不借连接补读', async (who) => {
  const f = fixture();
  await f.quoter.prepare(APP, ['viewer-l2']);
  f.publishedVersions.mockClear();
  f.configValue.mockClear();
  f.levelOf.mockClear();
  await expect(f.quoter.quote(item(), viewer(who), NORMAL)).rejects.toThrow();
  expect(f.publishedVersions).not.toHaveBeenCalled();
  expect(f.configValue).not.toHaveBeenCalled();
  expect(f.levelOf).not.toHaveBeenCalled();
});

it('[AC-B2-03c#33] 下一次 prepare 替换作用域并刷新数据，旧用户不能复用', async () => {
  const f = fixture();
  await f.quoter.prepare(APP, ['viewer-l2']);
  expect((await f.quoter.quote(item(), viewer({ userId: 'viewer-l2' }), NORMAL)).rebateMaxFen).toBe(
    550n,
  );
  f.values.set('tech_fee_bp', { taobao: 1000, jd: 0, pdd: 0 });
  f.userLevels.set(`${APP}/viewer-l3`, 'L1');
  await f.quoter.prepare(APP, ['viewer-l3']);
  f.levelOf.mockClear();
  f.publishedVersions.mockClear();
  f.configValue.mockClear();
  expect((await f.quoter.quote(item(), viewer({ userId: 'viewer-l3' }), NORMAL)).rebateMaxFen).toBe(
    450n,
  );
  await expect(f.quoter.quote(item(), viewer({ userId: 'viewer-l2' }), NORMAL)).rejects.toThrow();
  expect(f.levelOf).not.toHaveBeenCalled();
  expect(f.publishedVersions).not.toHaveBeenCalled();
  expect(f.configValue).not.toHaveBeenCalled();
});

it.each(['rules', 'levels', 'config'] as const)(
  '[AC-B2-03c#34] prepare 的 $0 失败不留下可用于报价的旧作用域',
  async (port) => {
    const f = fixture();
    await f.quoter.prepare(APP, ['viewer-l2']);
    if (port === 'rules') f.publishedVersions.mockRejectedValue(new Error('synthetic failure'));
    if (port === 'levels') f.levelOf.mockResolvedValue(null);
    if (port === 'config') f.configValue.mockResolvedValue(null);
    await expect(f.quoter.prepare(APP, ['viewer-l2'])).rejects.toThrow();
    f.publishedVersions.mockClear();
    f.levelOf.mockClear();
    f.configValue.mockClear();
    await expect(f.quoter.quote(item(), viewer({ userId: 'viewer-l2' }), NORMAL)).rejects.toThrow();
    expect(f.publishedVersions).not.toHaveBeenCalled();
    expect(f.levelOf).not.toHaveBeenCalled();
    expect(f.configValue).not.toHaveBeenCalled();
  },
);

it('[AC-B2-03c#35] 两个独立报价器的预读值不串用', async () => {
  const a = fixture();
  const b = fixture();
  b.values.set('tech_fee_bp', { taobao: 1000, jd: 0, pdd: 0 });
  b.userLevels.set(`${APP}/viewer-l2`, 'L3');
  await Promise.all([a.quoter.prepare(APP, ['viewer-l2']), b.quoter.prepare(APP, ['viewer-l2'])]);
  const who = viewer({ userId: 'viewer-l2' });
  const results = await Promise.all([
    a.quoter.quote(item(), who, NORMAL),
    b.quoter.quote(item(), who, NORMAL),
  ]);
  expect(results.map((r) => r.rebateMaxFen)).toEqual([550n, 540n]);
});
