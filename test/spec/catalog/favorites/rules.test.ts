// B1-28b: pure rules of the favorites use cases. The per-user cap favorites.max_per_user (规划/04
// §3.2 favorites, default 200; orchestrator semantics B.1: not a positive integer or the read
// fails → 200) and the invalid-card decision of the list (规划/04 §6.3 GET /v1/me/favorites:
// union says not found / off shelf / not promotable → invalid=true, the card has title and image
// only, no price and no rebate_*; 10 AC-S1-139).
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  favoriteCardView,
  readFavoritesCap,
  type FavoriteCardOutcome,
  type FavoriteUnavailableReason,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { BOUNDARY_FEN, CAP_KEY, boundaryCard, capConfig, pricedCard } from './kit.ts';

it('[AC-B1-28b#1] 上限读 favorites.max_per_user（按 app 读）：配 3 → 3，配 1 → 1，配 500 → 500', async () => {
  const three = capConfig(3);
  expect(await readFavoritesCap(three, 'fav-cap-app')).toBe(3);
  expect(three.calls).toContainEqual(['fav-cap-app', CAP_KEY]);
  expect(await readFavoritesCap(capConfig(1), 'fav-cap-app')).toBe(1);
  expect(await readFavoritesCap(capConfig(500), 'fav-cap-app')).toBe(500);
}, 10_000);

it.each([
  ['缺省（没有配置项）', undefined],
  ['0', 0],
  ['负数 -5', -5],
  ['小数 2.5', 2.5],
  ['字符串 "3"', '3'],
  ['null', null],
  ['布尔 true', true],
  ['超出安全整数', 2 ** 60],
  ['NaN', Number.NaN],
  ['对象', { max: 3 }],
])(
  '[AC-B1-28b#2] 上限配置 %s 不是正整数 → 按默认 200',
  async (_label, value) => {
    expect(await readFavoritesCap(capConfig(value), 'fav-cap-app')).toBe(200);
  },
  10_000,
);

it('[AC-B1-28b#3] 读配置失败（读取器拒绝）→ 按默认 200，不外抛', async () => {
  await expect(readFavoritesCap(capConfig(3, { fail: true }), 'fav-cap-app')).resolves.toBe(200);
}, 10_000);

it('[AC-B1-28b#4] 正常价格卡原样作为列表卡，invalid=false', () => {
  const card = pricedCard('tb:9001');
  const view = favoriteCardView({ kind: 'card', card });
  expect(view.invalid).toBe(false);
  expect(view.productCard).toEqual(pricedCard('tb:9001'));
}, 10_000);

it.each(['not_found', 'off_shelf', 'not_promotable'] as const)(
  '[AC-B1-28b#5] 联盟返回 %s → invalid=true，卡只有 title 与 image 两个键（无价格、无 rebate_*）',
  (reason: FavoriteUnavailableReason) => {
    const view = favoriteCardView({
      kind: 'unavailable',
      reason,
      title: '已下架的演示商品',
      image: 'https://example.com/gone.png',
    });
    expect(view).toEqual({
      invalid: true,
      productCard: { title: '已下架的演示商品', image: 'https://example.com/gone.png' },
    });
    expect(Object.keys(view.productCard).sort()).toEqual(['image', 'title']);
  },
  10_000,
);

it('[AC-B1-28b#6] 联盟不存在且标题与图都不知道 → invalid=true，卡为 { title: null, image: null }', () => {
  const view = favoriteCardView({
    kind: 'unavailable',
    reason: 'not_found',
    title: null,
    image: null,
  });
  expect(view).toEqual({ invalid: true, productCard: { title: null, image: null } });
}, 10_000);

it('[AC-B1-28b#7] 取到的卡 availability=off_shelf（已下架）→ invalid=true，只留该卡的 title 与 image', () => {
  const view = favoriteCardView({
    kind: 'card',
    card: pricedCard('tb:9002', { availability: 'off_shelf', title: '下架商品', image: null }),
  });
  expect(view).toEqual({ invalid: true, productCard: { title: '下架商品', image: null } });
}, 10_000);

// Amounts: explicit boundaries (0, 1, odd, > 2^31), ordinary small amounts, odd amounts, and
// amounts beyond the signed 32-bit range up to the largest safe integer (review r1 S1).
const fenArb = fc.option(
  fc.oneof(
    fc.constantFrom(...BOUNDARY_FEN),
    fc.integer({ min: 0, max: 10_000_000 }),
    fc.integer({ min: 0, max: 5_000_000 }).map((n) => n * 2 + 1),
    fc.bigInt({ min: 2n ** 31n, max: BigInt(Number.MAX_SAFE_INTEGER) }).map((n) => Number(n)),
  ),
  { nil: null },
);
const textArb = fc.option(fc.string({ maxLength: 20 }), { nil: null });
const outcomeArb: fc.Arbitrary<FavoriteCardOutcome> = fc.oneof(
  fc.record({
    kind: fc.constant('unavailable' as const),
    reason: fc.constantFrom<FavoriteUnavailableReason>('not_found', 'off_shelf', 'not_promotable'),
    title: textArb,
    image: textArb,
  }),
  fc
    .record({
      title: textArb,
      image: textArb,
      price: fenArb,
      coupon: fenArb,
      finalPrice: fenArb,
      estNet: fenArb,
      rebateMin: fenArb,
      rebateMax: fenArb,
      availability: fc.constantFrom(
        'ok' as const,
        'off_shelf' as const,
        'coupon_gone' as const,
        'ref_expired' as const,
        'unknown' as const,
      ),
    })
    .map(
      ({
        title,
        image,
        price,
        coupon,
        finalPrice,
        estNet,
        rebateMin,
        rebateMax,
        availability,
      }) => ({
        kind: 'card' as const,
        card: pricedCard('tb:9100', {
          title,
          image,
          price_fen: price,
          coupon_fen: coupon,
          final_price_fen: finalPrice,
          est_net_price_fen: estNet,
          rebate_min_fen: rebateMin,
          rebate_max_fen: rebateMax,
          availability,
        }),
      }),
    ),
);

function expectedInvalid(outcome: FavoriteCardOutcome): boolean {
  return outcome.kind === 'unavailable' || outcome.card.availability === 'off_shelf';
}

it('[AC-B1-28b#8] 属性：失效卡任何情况下都只含 title 与 image（无 *_fen、无 rebate_*），有效卡原样不改', () => {
  let invalidSeen = 0;
  fc.assert(
    fc.property(outcomeArb, (outcome) => {
      const view = favoriteCardView(outcome);
      expect(view.invalid).toBe(expectedInvalid(outcome));
      if (view.invalid) {
        invalidSeen += 1;
        const keys = Object.keys(view.productCard).sort();
        expect(keys).toEqual(['image', 'title']);
        const source = outcome.kind === 'card' ? outcome.card : outcome;
        expect(view.productCard).toEqual({ title: source.title, image: source.image });
      } else {
        expect(outcome.kind).toBe('card');
        expect(view.productCard).toEqual(outcome.kind === 'card' ? outcome.card : null);
      }
    }),
    propParams(),
  );
  expect(invalidSeen).toBeGreaterThan(0);
}, 120_000);

it.each([
  [0, 0],
  [1, 1],
  [3, 3],
  [999, 999],
  [2147483647, 2147483647],
  [2147483648, 2147483648],
  [2147483649, 2147483649],
  [4294967297, 4294967297],
  [9007199254740991, 9007199254740991],
])(
  '[AC-B1-28b#46] 有效卡金额 %d 分（0、1、奇数、> 2^31）原样保留，不做 32 位截断或改号',
  (fen: number, expected: number) => {
    const view = favoriteCardView({ kind: 'card', card: boundaryCard('tb:9200', fen) });
    expect(view.invalid).toBe(false);
    expect(view.productCard).toMatchObject({
      price_fen: expected,
      coupon_fen: expected,
      final_price_fen: expected,
      est_net_price_fen: expected,
      rebate_min_fen: expected,
      rebate_max_fen: expected,
    });
    expect(view.productCard).toEqual(boundaryCard('tb:9200', expected));
  },
  10_000,
);
