import { quoteRebate } from '@couli/domain';
import { expect, it } from 'vitest';
import type { CardRebateQuoter } from '../../../../apps/api/src/modules/catalog/index.ts';
import { APP, COMPARE, NORMAL, PLATFORMS, fixture, item, version, viewer } from './fixtures.ts';

it.each([
  { reserve: 0, expected: 269n, net: 2721n },
  { reserve: 1500, expected: 229n, net: 2761n },
])(
  '[AC-B2-03c#1] BR-CALC-20 示例：539 分联盟收入，预留 $reserve 得本人 $expected',
  async ({ reserve, expected, net }) => {
    const f = fixture();
    f.values.set('tech_fee_bp', { taobao: 1000, jd: 0, pdd: 0 });
    f.versions.set(APP, [
      version({ reserves: PLATFORMS.map((platform) => ({ platform, reserve_bp: reserve })) }),
    ]);
    const cardPort: CardRebateQuoter = f.quoter;
    const result = await cardPort.quote(
      item({
        price_fen: 3990n,
        coupon_fen: 1000n,
        final_price_fen: 2990n,
        commission_rate_bp: 2000n,
      }),
      viewer(),
      NORMAL,
    );
    expect(result).toEqual({
      rebateMinFen: expected,
      rebateMaxFen: expected,
      estNetPriceFen: net,
      rebateBasis: 'normal',
    });
    expect(result.rebateMaxFen).toBe(
      quoteRebate({ n_quote_fen: 539n, reserve_bp: BigInt(reserve), r_own_bp: 5000n }),
    );
  },
);

it.each([
  { userId: null, expected: 500n },
  { userId: 'viewer-l1', expected: 500n },
  { userId: 'viewer-l2', expected: 550n },
  { userId: 'viewer-l3', expected: 600n },
])('[AC-B2-03c#2] BR-CALC-20 查看者 $userId 取自己的当前等级', async ({ userId, expected }) => {
  const f = fixture();
  const result = await f.quoter.quote(item(), viewer({ userId }), NORMAL);
  expect(result.rebateMaxFen).toBe(expected);
  expect(result.rebateMinFen).toBe(expected);
  if (userId === null) expect(f.levelOf).not.toHaveBeenCalled();
  else expect(f.levelOf).toHaveBeenCalledWith({ appId: APP, userId });
});

it.each([
  { platform: 'taobao', expected: 450n, net: 9550n },
  { platform: 'jd', expected: 256n, net: 9744n },
  { platform: 'pdd', expected: 126n, net: 9874n },
] as const)(
  '[AC-B2-03c#3] BR-CALC-06 $platform 使用同版本本平台比例、预留和技术服务费',
  async ({ platform, expected, net }) => {
    const f = fixture();
    const base = version();
    f.values.set('tech_fee_bp', { taobao: 0, jd: 2000, pdd: 2000 });
    f.versions.set(APP, [
      version({
        rules: base.rules.map((r) => ({
          ...r,
          r_own_bp: r.platform === 'taobao' ? 5000 : r.platform === 'jd' ? 4000 : 3000,
        })),
        reserves: [
          { platform: 'taobao', reserve_bp: 1000 },
          { platform: 'jd', reserve_bp: 2000 },
          { platform: 'pdd', reserve_bp: 3000 },
        ],
      }),
    ]);
    expect(await f.quoter.quote(item({ platform }), viewer(), NORMAL)).toEqual({
      rebateMinFen: expected,
      rebateMaxFen: expected,
      estNetPriceFen: net,
      rebateBasis: 'normal',
    });
  },
);

it.each([
  { buyType: 'self', expected: 150n },
  { buyType: 'share', expected: 160n },
] as const)(
  '[AC-B2-03c#4] BR-CALC-20 PDD $buyType 透传口径并取对应规则行',
  async ({ buyType, expected }) => {
    const f = fixture();
    f.versions.set(APP, [
      version({
        rules: version().rules.map((r) => ({
          ...r,
          r_own_bp: r.order_type === 'self' ? 5000 : 4000,
        })),
      }),
    ]);
    // N_share=400; self factor 7500 → N_self=300 → own=150.
    // Share skips the self factor, uses the share row: 400 × 4000bp → 160.
    expect(
      (
        await f.quoter.quote(item({ platform: 'pdd', commission_rate_bp: 400n }), viewer(), {
          ...NORMAL,
          buyType,
        })
      ).rebateMaxFen,
    ).toBe(expected);
  },
);

it('[AC-B2-03c#5] BR-CALC-20 拼多多两个系数都传给 union，单次乘除不提前取整', async () => {
  const f = fixture();
  f.values.set('union.pdd.self_buy_factor_bp', 3333);
  f.values.set('union.pdd.account_level_factor_bp', 6667);
  // N=11; floor(11 × .3333 × .6667)=2, premature flooring would yield 1.
  const result = await f.quoter.quote(
    item({ platform: 'pdd', commission_rate_bp: 11n }),
    viewer(),
    NORMAL,
  );
  expect(result.rebateMaxFen).toBe(1n);
  expect(result.rebateBasis).toBe('normal');
});

it('[AC-B2-03c#6] BR-PRICE-07 下限从佣金率重算每一步，不直接折半最终返利', async () => {
  const f = fixture();
  f.values.set('tech_fee_bp', { taobao: 1379, jd: 0, pdd: 0 });
  f.versions.set(APP, [
    version({
      rules: version().rules.map((r) => ({ ...r, r_own_bp: 4567 })),
      reserves: PLATFORMS.map((platform) => ({ platform, reserve_bp: 1234 })),
    }),
  ]);
  // Max: gross 1235, fee 170, N 1065, B 933, own 426.
  // Min: rate 617, gross 617, fee 85, N 532, B 466, own 212 (not 213).
  expect(
    await f.quoter.quote(
      item({
        price_fen: 11000n,
        coupon_fen: 997n,
        final_price_fen: 10003n,
        commission_rate_bp: 1235n,
      }),
      viewer(),
      COMPARE,
    ),
  ).toEqual({
    rebateMinFen: 212n,
    rebateMaxFen: 426n,
    estNetPriceFen: 9791n,
    rebateBasis: 'price_compare_risk',
  });
});

it('[AC-B2-03c#7] BR-PRICE-07 下限零而上限正数仍保留区间', async () => {
  const f = fixture();
  expect(
    await f.quoter.quote(
      item({ price_fen: 3n, coupon_fen: 0n, final_price_fen: 3n, commission_rate_bp: 10000n }),
      viewer(),
      COMPARE,
    ),
  ).toEqual({
    rebateMinFen: 0n,
    rebateMaxFen: 1n,
    estNetPriceFen: 3n,
    rebateBasis: 'price_compare_risk',
  });
});

it.each(['zero-rate', 'tiny-share', 'full-reserve', 'zero-own', 'full-fee'] as const)(
  '[AC-B2-03c#8] BR-PRICE-08 $0 导致上限零，返后价为空',
  async (reason) => {
    const f = fixture();
    let product = item();
    if (reason === 'zero-rate') product = item({ commission_rate_bp: 0n });
    if (reason === 'tiny-share')
      product = item({
        price_fen: 1n,
        coupon_fen: 0n,
        final_price_fen: 1n,
        commission_rate_bp: 10000n,
      });
    if (reason === 'full-reserve')
      f.versions.set(APP, [
        version({ reserves: PLATFORMS.map((platform) => ({ platform, reserve_bp: 10000 })) }),
      ]);
    if (reason === 'zero-own')
      f.versions.set(APP, [
        version({ rules: version().rules.map((r) => ({ ...r, r_own_bp: 0 })) }),
      ]);
    if (reason === 'full-fee') f.values.set('tech_fee_bp', { taobao: 10000, jd: 0, pdd: 0 });
    expect(await f.quoter.quote(product, viewer(), COMPARE)).toEqual({
      rebateMinFen: 0n,
      rebateMaxFen: 0n,
      estNetPriceFen: null,
      rebateBasis: 'no_rebate',
    });
  },
);

it('[AC-B2-03c#9] BR-CALC-20 大整数金额保持精度且使用券后价', async () => {
  const f = fixture();
  // Both intermediate final×rate and N exceed Number's safe integer range.
  const result = await f.quoter.quote(
    item({
      price_fen: 9007199254741000n,
      coupon_fen: 5n,
      final_price_fen: 9007199254740995n,
      commission_rate_bp: 10000n,
    }),
    viewer(),
    NORMAL,
  );
  expect(result).toEqual({
    rebateMinFen: 4503599627370497n,
    rebateMaxFen: 4503599627370497n,
    estNetPriceFen: 4503599627370498n,
    rebateBasis: 'normal',
  });
});

it.each(['taobao', 'jd', 'pdd'] as const)(
  '[AC-B2-03c#10] 省略 context 时 $0 按游客自购和无来源语义报价',
  async (platform) => {
    const f = fixture();
    expect(await f.quoter.quote(item({ platform }), viewer())).toEqual(
      platform === 'taobao'
        ? {
            rebateMinFen: 250n,
            rebateMaxFen: 500n,
            estNetPriceFen: 9750n,
            rebateBasis: 'price_compare_risk',
          }
        : {
            rebateMinFen: platform === 'pdd' ? 375n : 500n,
            rebateMaxFen: platform === 'pdd' ? 375n : 500n,
            estNetPriceFen: platform === 'pdd' ? 9625n : 9500n,
            rebateBasis: 'normal',
          },
    );
  },
);
