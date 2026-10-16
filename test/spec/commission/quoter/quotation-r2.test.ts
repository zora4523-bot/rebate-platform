import { expect, it } from 'vitest';
import { APP, COMPARE, NORMAL, fixture, item, version, viewer } from './fixtures.ts';

it('[AC-B2-03c#39] BR-PRICE-07 比价系数先乘佣金率，不能乘 gross、N 或 B', async () => {
  const f = fixture();
  f.values.set('rebate.taobao.compare_rate_ratio_bp', 5000);
  f.values.set('tech_fee_bp', { taobao: 0, jd: 0, pdd: 0 });
  f.versions.set(APP, [
    version({
      rules: version().rules.map((r) => ({ ...r, r_own_bp: 8000, r_direct_bp: 0 })),
    }),
  ]);
  // 下限率 = floor(1235 × 5000 / 10000) = 617。
  // 下限 gross = floor(20000 × 617 / 10000) = 1234；fee = 0，N = 1234。
  // reserve_bp = 0，B = 1234；本人 = floor(1234 × 8000 / 10000) = 987。
  // 上限 gross = floor(20000 × 1235 / 10000) = 2470；fee = 0，N = B = 2470。
  // 上限本人 = floor(2470 × 8000 / 10000) = 1976；返后价 = 20000 − 987 = 19013。
  // 若先算 gross、N 或 B 再乘系数：floor(2470 × 5000 / 10000) = 1235，
  // 本人会错误地变成 floor(1235 × 8000 / 10000) = 988。
  expect(
    await f.quoter.quote(
      item({
        price_fen: 20000n,
        coupon_fen: 0n,
        final_price_fen: 20000n,
        commission_rate_bp: 1235n,
      }),
      viewer(),
      COMPARE,
    ),
  ).toEqual({
    rebateMinFen: 987n,
    rebateMaxFen: 1976n,
    estNetPriceFen: 19013n,
    rebateBasis: 'price_compare_risk',
  });
});

it('[AC-B2-03c#40] BR-CALC-20 拼多多自购同时应用自购系数和账号等级系数', async () => {
  const f = fixture();
  f.values.set('union.pdd.self_buy_factor_bp', 7500);
  f.values.set('union.pdd.account_level_factor_bp', 8000);
  // gross = floor(10000 × 400 / 10000) = 400，fee = 0。
  // 自购 N = floor(400 × 7500 × 8000 / 100000000) = 240。
  // reserve_bp = 0，B = 240；本人 = floor(240 × 5000 / 10000) = 120。
  // 忽略账号等级系数会得到 150，不能通过此断言。
  expect(
    await f.quoter.quote(item({ platform: 'pdd', commission_rate_bp: 400n }), viewer(), NORMAL),
  ).toEqual({
    rebateMinFen: 120n,
    rebateMaxFen: 120n,
    estNetPriceFen: 9880n,
    rebateBasis: 'normal',
  });
});

it('[AC-B2-03c#41] BR-CALC-20 拼多多分享应用账号等级系数，不应用自购系数', async () => {
  const f = fixture();
  f.values.set('union.pdd.self_buy_factor_bp', 7500);
  f.values.set('union.pdd.account_level_factor_bp', 8000);
  // gross = 400，fee = 0；分享 N = floor(400 × 8000 / 10000) = 320。
  // reserve_bp = 0，B = 320；L1 share 本人 = floor(320 × 5000 / 10000) = 160。
  // 忽略账号等级系数会得到 200，误用自购系数会得到 120。
  expect(
    await f.quoter.quote(item({ platform: 'pdd', commission_rate_bp: 400n }), viewer(), {
      ...NORMAL,
      buyType: 'share',
    }),
  ).toEqual({
    rebateMinFen: 160n,
    rebateMaxFen: 160n,
    estNetPriceFen: 9840n,
    rebateBasis: 'normal',
  });
});

it('[AC-B2-03c#42] BR-PRICE-08 淘宝 normal 报价为零时标记无返利且返后价为空', async () => {
  const f = fixture();
  expect(
    await f.quoter.quote(item({ platform: 'taobao', commission_rate_bp: 0n }), viewer(), NORMAL),
  ).toEqual({
    rebateMinFen: 0n,
    rebateMaxFen: 0n,
    estNetPriceFen: null,
    rebateBasis: 'no_rebate',
  });
});

it('[AC-B2-03c#43] BR-PRICE-08 京东 normal 报价为零时标记无返利且返后价为空', async () => {
  const f = fixture();
  expect(
    await f.quoter.quote(item({ platform: 'jd', commission_rate_bp: 0n }), viewer(), NORMAL),
  ).toEqual({
    rebateMinFen: 0n,
    rebateMaxFen: 0n,
    estNetPriceFen: null,
    rebateBasis: 'no_rebate',
  });
});

it('[AC-B2-03c#44] BR-PRICE-08 拼多多 normal 报价为零时标记无返利且返后价为空', async () => {
  const f = fixture();
  expect(
    await f.quoter.quote(item({ platform: 'pdd', commission_rate_bp: 0n }), viewer(), NORMAL),
  ).toEqual({
    rebateMinFen: 0n,
    rebateMaxFen: 0n,
    estNetPriceFen: null,
    rebateBasis: 'no_rebate',
  });
});
