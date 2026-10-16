// B1-17b: which union returns may be written to price_snapshot (BR-WATCH-05: failed queries never;
// BR-WATCH-19 (1): no user-level parameter, PDD only with its goods_sign plan; orchestrator
// semantics B.2: price anomaly (BR-PRICE-01 via union's isPriceAnomaly), cache / stale, convert).
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  priceSnapshotSkipReason,
  type PriceObservation,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { observation } from './kit.ts';

it.each([
  ['taobao detail', observation()],
  ['jd search', observation({ platform: 'jd', productKey: 'jd:9', sourceKind: 'search' })],
  ['taobao quote', observation({ sourceKind: 'quote' })],
  ['taobao watch', observation({ sourceKind: 'watch' })],
  [
    'pdd detail with plan',
    observation({ platform: 'pdd', productKey: 'pdd:7', goodsSignPlan: 'detail' }),
  ],
  [
    'pdd search with plan',
    observation({
      platform: 'pdd',
      productKey: 'pdd:7',
      sourceKind: 'search',
      goodsSignPlan: 'search',
    }),
  ],
  [
    'out of stock with coupon',
    observation({ inStock: false, couponFen: 600n, finalPriceFen: 3900n }),
  ],
] as const)(
  '[AC-B1-17b#11] 可写：%s（新鲜返回、无用户级参数、价格正常）',
  (_name, obs) => {
    expect(priceSnapshotSkipReason(obs)).toBeNull();
  },
  10_000,
);

it.each(['failed', 'timeout', 'rate_limited'] as const)(
  '[AC-B1-17b#12] BR-WATCH-05 失败查询不写：outcome=%s → upstream_failed',
  (outcome) => {
    expect(priceSnapshotSkipReason(observation({ outcome }))).toBe('upstream_failed');
  },
  10_000,
);

it.each([
  ['price_status=anomaly', { priceStatus: 'anomaly' }],
  ['price_fen=0', { priceFen: 0n, couponFen: 0n, finalPriceFen: 0n }],
  ['coupon ≥ price', { priceFen: 4500n, couponFen: 4500n, finalPriceFen: 1n }],
  ['coupon < 0', { priceFen: 4500n, couponFen: -1n, finalPriceFen: 4501n }],
  ['final ≠ price − coupon', { priceFen: 4500n, couponFen: 500n, finalPriceFen: 4100n }],
  ['final ≤ 0', { priceFen: 4500n, couponFen: 0n, finalPriceFen: 0n }],
] as const)(
  '[AC-B1-17b#13] BR-PRICE-01 价格异常不写：%s → price_anomaly',
  (_name, fields) => {
    expect(priceSnapshotSkipReason(observation(fields))).toBe('price_anomaly');
  },
  10_000,
);

it('[AC-B1-17b#14] 缓存命中或 stale 结果（非联盟新鲜返回）不写 → not_fresh', () => {
  expect(priceSnapshotSkipReason(observation({ fresh: false }))).toBe('not_fresh');
  expect(priceSnapshotSkipReason(observation({ fresh: false, sourceKind: 'search' }))).toBe(
    'not_fresh',
  );
}, 10_000);

it('[AC-B1-17b#15] BR-WATCH-19 带用户级参数的返回不写 → user_scoped', () => {
  expect(priceSnapshotSkipReason(observation({ userScoped: true }))).toBe('user_scoped');
  expect(
    priceSnapshotSkipReason(
      observation({
        platform: 'pdd',
        productKey: 'pdd:7',
        userScoped: true,
        goodsSignPlan: 'search',
      }),
    ),
  ).toBe('user_scoped');
}, 10_000);

it('[AC-B1-17b#16] BR-WATCH-19 细则例：转链返回不写（即使新鲜且未标用户级参数）→ convert', () => {
  expect(priceSnapshotSkipReason(observation({ sourceKind: 'convert' }))).toBe('convert');
  expect(
    priceSnapshotSkipReason(
      observation({ sourceKind: 'convert', priceFen: 3900n, finalPriceFen: 3900n }),
    ),
  ).toBe('convert');
}, 10_000);

it('[AC-B1-17b#17] BR-WATCH-19 + 裁定 6：拼多多没有 goods_sign_plan 不写 → pdd_without_plan；他平台无 plan 照写', () => {
  expect(
    priceSnapshotSkipReason(
      observation({ platform: 'pdd', productKey: 'pdd:7', goodsSignPlan: null }),
    ),
  ).toBe('pdd_without_plan');
  expect(priceSnapshotSkipReason(observation({ platform: 'jd', goodsSignPlan: null }))).toBeNull();
}, 10_000);

it('[AC-B1-17b#18] 观测类型不允许携带任何用户标识（类型层面拒绝），带标志的仍被拒写', () => {
  const base = observation({ userScoped: true });
  // @ts-expect-error BR-WATCH-19: no user_id on an observation
  const withUser: PriceObservation = { ...base, userId: 'u-1' };
  // @ts-expect-error BR-WATCH-19: no device_id on an observation
  const withDevice: PriceObservation = { ...base, deviceId: 'd-1' };
  // @ts-expect-error BR-WATCH-19: no relation_id on an observation
  const withRelation: PriceObservation = { ...base, relationId: 'r-1' };
  // @ts-expect-error BR-WATCH-19: no subUnionId on an observation
  const withSubUnion: PriceObservation = { ...base, subUnionId: 's-1' };
  // @ts-expect-error BR-WATCH-19: no custom_parameters on an observation
  const withCustom: PriceObservation = { ...base, customParameters: 'c-1' };
  for (const obs of [withUser, withDevice, withRelation, withSubUnion, withCustom]) {
    expect(priceSnapshotSkipReason(obs)).toBe('user_scoped');
  }
}, 10_000);

const ORDER = [
  'upstream_failed',
  'price_anomaly',
  'not_fresh',
  'user_scoped',
  'convert',
  'pdd_without_plan',
] as const;

const observationArb = fc
  .record({
    platform: fc.constantFrom('taobao', 'jd', 'pdd'),
    sourceKind: fc.constantFrom('search', 'detail', 'quote', 'convert', 'watch'),
    outcome: fc.constantFrom('ok', 'ok', 'ok', 'failed', 'timeout', 'rate_limited'),
    priceFen: fc.bigInt({ min: -2n, max: 20_000n }),
    coupon: fc.bigInt({ min: -2n, max: 20_000n }),
    finalMode: fc.constantFrom('exact', 'exact', 'off'),
    finalOff: fc.bigInt({ min: -3n, max: 3n }),
    priceStatus: fc.constantFrom('ok', 'ok', 'ok', 'anomaly'),
    inStock: fc.boolean(),
    fresh: fc.boolean(),
    userScoped: fc.boolean(),
    goodsSignPlan: fc.constantFrom(null, 'search', 'detail'),
  })
  .map((r): PriceObservation =>
    observation({
      platform: r.platform,
      productKey: `${r.platform === 'taobao' ? 'tb' : r.platform}:P1`,
      sourceKind: r.sourceKind,
      outcome: r.outcome,
      priceFen: r.priceFen,
      couponFen: r.coupon,
      finalPriceFen: r.priceFen - r.coupon + (r.finalMode === 'exact' ? 0n : r.finalOff),
      priceStatus: r.priceStatus,
      inStock: r.inStock,
      fresh: r.fresh,
      userScoped: r.userScoped,
      goodsSignPlan: r.goodsSignPlan,
    }),
  );

/** Independent derivation of the rules, in the documented order. */
function expectedReason(o: PriceObservation): (typeof ORDER)[number] | null {
  const anomaly =
    o.priceStatus === 'anomaly' ||
    o.priceFen <= 0n ||
    o.couponFen < 0n ||
    o.couponFen >= o.priceFen ||
    o.finalPriceFen <= 0n ||
    o.finalPriceFen !== o.priceFen - o.couponFen;
  const reasons: Record<(typeof ORDER)[number], boolean> = {
    upstream_failed: o.outcome !== 'ok',
    price_anomaly: anomaly,
    not_fresh: !o.fresh,
    user_scoped: o.userScoped,
    convert: o.sourceKind === 'convert',
    pdd_without_plan: o.platform === 'pdd' && o.goodsSignPlan === null,
  };
  return ORDER.find((reason) => reasons[reason]) ?? null;
}

it('[AC-B1-17b#19] 属性：可写当且仅当 成功 ∧ 价格正常 ∧ 新鲜 ∧ 无用户级参数 ∧ 非转链 ∧（非拼多多 ∨ 有 plan），拒写原因按约定顺序取第一个', () => {
  let checked = 0;
  fc.assert(
    fc.property(observationArb, (obs) => {
      expect(priceSnapshotSkipReason(obs)).toBe(expectedReason(obs));
      checked += 1;
    }),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 120_000);
