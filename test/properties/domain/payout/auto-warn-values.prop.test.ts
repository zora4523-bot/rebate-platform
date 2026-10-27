// B2-11b properties of the ⑧ actual values and of ⑨ = 0 (规划/08 BR-WDR-30 细则 ⑧ ⑨, BR-WDR-29
// ④⑤⑥ windows and numerators / denominators; orchestrator ruling D10-377). The reference model is
// written from the rule text, never from the implementation:
//   high commission = |orders with rate > X| × 10000 / |orders|; invalid = |invalid orders| ×
//   10000 / |orders|; withdraw / received = withdrawn_30d × 10000 / received_60d; no minimum
//   counts; denominator 0 → null; a value between two whole bp is rounded up; the values do not
//   depend on Y, Z, W or on the order of the rows;
//   through decideAutoPayout the ⑧ codes are exactly the rule's exact comparisons: Y ≠ 0 and
//   orders > 0 and high × 10000 > Y × orders; Z likewise; W ≠ 0 and (received = 0 or withdrawn ×
//   10000 > W × received);
//   ⑨ platform_daily_max_fen = 0 fails every amount ≥ 1 fen (withdrawals.amount_fen > 0), whatever
//   the platform sum (D10-377: the same reading as ② 0, not "unlimited"); no 0 → 1 replacement.
// Properties follow test/properties/README.md: boolean bodies, one summary assertion after
// fc.assert, amount tiers 0, 1, odd, > 2^31 each in at least 1% of the runs.
import { isDeepStrictEqual } from 'node:util';
import { createPropStats, propParams, type PropStatsRecord } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  computeAutoPayoutWarnValues,
  decideAutoPayout,
  type AutoPayoutConfig,
  type AutoPayoutWarnSource,
  type AutoPayoutWarnValues,
} from '../../../../apps/api/src/modules/payout/domain/auto-decision.ts';
import { defaults, passing } from '../../../spec/payout/auto-decision/kit.ts';

const TWO_31 = 2n ** 31n;
const TIERS = ['zero', 'one', 'odd', 'above-2^31'] as const;

type Warn = AutoPayoutConfig['warn'];

function tiersOf(...amounts: bigint[]): string[] {
  const hit = new Set<string>();
  for (const fen of amounts) {
    if (fen === 0n) hit.add('zero');
    if (fen === 1n) hit.add('one');
    if (fen % 2n === 1n) hit.add('odd');
    if (fen > TWO_31) hit.add('above-2^31');
  }
  return [...hit];
}

function summary(record: PropStatsRecord, tiers: readonly string[]) {
  const runs = record.hits['run'] ?? 0;
  return {
    runs,
    discards: record.discards,
    thin: tiers.filter((tier) => (record.hits[tier] ?? 0) * 100 < runs),
  };
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function ratio(numerator: bigint, denominator: bigint): number | null {
  return denominator === 0n ? null : Number(ceilDiv(numerator * 10000n, denominator));
}

function counts(source: AutoPayoutWarnSource, x: number) {
  return {
    orders: BigInt(source.orders_60d.length),
    high: BigInt(source.orders_60d.filter((o) => o.commission_rate_bp > x).length),
    invalid: BigInt(source.orders_60d.filter((o) => o.invalid).length),
  };
}

function model(source: AutoPayoutWarnSource, x: number): AutoPayoutWarnValues {
  const c = counts(source, x);
  return {
    high_commission_order_ratio_bp: ratio(c.high, c.orders),
    invalid_ratio_bp: ratio(c.invalid, c.orders),
    withdraw_received_ratio_bp: ratio(source.withdrawn_30d_fen, source.received_60d_fen),
  };
}

/** The ⑧ codes by the exact comparisons of the rule text (no rounding involved). */
function expectedCodes(source: AutoPayoutWarnSource, warn: Warn): string[] {
  const c = counts(source, warn.high_commission_rate_bp);
  const exceeds = (num: bigint, den: bigint, threshold: number) =>
    num * 10000n > BigInt(threshold) * den;
  const out: string[] = [];
  const y = warn.high_commission_order_ratio_bp;
  if (y !== 0 && c.orders > 0n && exceeds(c.high, c.orders, y)) out.push('warn_high_commission');
  const z = warn.invalid_ratio_bp;
  if (z !== 0 && c.orders > 0n && exceeds(c.invalid, c.orders, z)) out.push('warn_invalid_ratio');
  const w = warn.withdraw_received_ratio_bp;
  const r = source.received_60d_fen;
  if (w !== 0 && (r === 0n || exceeds(source.withdrawn_30d_fen, r, w))) {
    out.push('warn_withdraw_received');
  }
  return out;
}

const fen = fc.oneof(
  fc.constantFrom(0n, 1n),
  fc.bigInt({ min: 0n, max: 10n ** 6n }).map((v) => 2n * v + 1n),
  fc.bigInt({ min: TWO_31 + 1n, max: 10n ** 15n }),
  fc.bigInt({ min: 0n, max: 10n ** 12n }),
);
const positiveFen = fc.oneof(
  fc.constant(1n),
  fc.bigInt({ min: 0n, max: 10n ** 6n }).map((v) => 2n * v + 1n),
  fc.bigInt({ min: TWO_31 + 1n, max: 10n ** 15n }),
  fc.bigInt({ min: 1n, max: 10n ** 12n }),
);
const bp = fc.oneof(
  fc.constantFrom(0, 1, 3000, 3333, 3334, 5000, 6666, 6667, 9999, 10000),
  fc.integer({ min: 0, max: 10000 }),
);
const rate = fc.oneof(
  fc.constantFrom(0, 1, 4999, 5000, 5001, 9999, 10000, 10001),
  fc.integer({ min: 0, max: 10001 }),
);
const orders = fc.oneof(
  { arbitrary: fc.constant([]), weight: 1 },
  {
    arbitrary: fc.array(
      fc.record({ commission_rate_bp: rate, invalid: fc.boolean() }, { noNullPrototype: true }),
      { minLength: 1, maxLength: 40 },
    ),
    weight: 9,
  },
);

/** A ⑧ source; the withdraw / received ratio is kept below 10^15 bp (a safe integer). */
const anySource: fc.Arbitrary<AutoPayoutWarnSource> = fc
  .record({ orders, withdrawn: fen, received: fen })
  .map((g) => ({
    orders_60d: g.orders,
    withdrawn_30d_fen: g.received === 0n ? g.withdrawn : g.withdrawn % (g.received * 10n ** 11n),
    received_60d_fen: g.received,
  }));

const anyWarn: fc.Arbitrary<Warn> = fc.tuple(bp, bp, bp, bp).map(([x, y, z, w]) => ({
  high_commission_rate_bp: x,
  high_commission_order_ratio_bp: y,
  invalid_ratio_bp: z,
  withdraw_received_ratio_bp: w,
}));

const EDGE_MODES = ['floor', 'floor-1', 'ceil', 'random'] as const;
const edgeMode = fc.constantFrom(...EDGE_MODES);

/** A threshold on the edge of numerator × 10000 / denominator, inside the 0–10000 range. */
function edge(mode: (typeof EDGE_MODES)[number], num: bigint, den: bigint, t: number): number {
  if (mode === 'random' || den === 0n) return t;
  const floor = (num * 10000n) / den;
  const value = { floor, 'floor-1': floor - 1n, ceil: ceilDiv(num * 10000n, den) }[mode];
  return Number(value < 0n ? 0n : value > 10000n ? 10000n : value);
}

/** A source with Y, Z, W often on the edge of the actual ratios. */
const sourceAndWarn = fc
  .record({ source: anySource, warn: anyWarn, modes: fc.tuple(edgeMode, edgeMode, edgeMode) })
  .map(({ source, warn, modes }) => {
    const c = counts(source, warn.high_commission_rate_bp);
    const tuned: Warn = {
      high_commission_rate_bp: warn.high_commission_rate_bp,
      high_commission_order_ratio_bp: edge(
        modes[0],
        c.high,
        c.orders,
        warn.high_commission_order_ratio_bp,
      ),
      invalid_ratio_bp: edge(modes[1], c.invalid, c.orders, warn.invalid_ratio_bp),
      withdraw_received_ratio_bp: edge(
        modes[2],
        source.withdrawn_30d_fen,
        source.received_60d_fen,
        warn.withdraw_received_ratio_bp,
      ),
    };
    return { source, warn: tuned };
  });

it('[AC-B2-11b#67] computeAutoPayoutWarnValues 属性：与规则模型一致（> X、无最少单数、分母 0 → null、向上取整），与 Y/Z/W 和行顺序无关', () => {
  const params = propParams();
  const stats = createPropStats('B2-11b:warn-values');
  const generated = fc.tuple(anySource, anyWarn, anyWarn).chain(([source, warn, other]) =>
    fc.tuple(
      fc.constant(source),
      fc.constant(warn),
      fc.constant(other),
      fc.shuffledSubarray([...source.orders_60d], {
        minLength: source.orders_60d.length,
        maxLength: source.orders_60d.length,
      }),
    ),
  );
  fc.assert(
    fc.property(generated, ([source, warn, other, shuffled]) => {
      stats.hit('run');
      for (const tier of tiersOf(source.withdrawn_30d_fen, source.received_60d_fen)) {
        stats.hit(tier);
      }
      if (source.orders_60d.length === 0) stats.hit('no-orders');
      if (source.received_60d_fen === 0n) stats.hit('no-received');
      const before = structuredClone(source);
      const values = computeAutoPayoutWarnValues(source, warn);
      const unchanged = isDeepStrictEqual(source, before);
      const sameX = { ...other, high_commission_rate_bp: warn.high_commission_rate_bp };
      const permuted = computeAutoPayoutWarnValues({ ...source, orders_60d: shuffled }, sameX);
      return (
        unchanged &&
        isDeepStrictEqual(values, model(source, warn.high_commission_rate_bp)) &&
        isDeepStrictEqual(permuted, values)
      );
    }),
    params,
  );
  expect(summary(stats.flush(), [...TIERS, 'no-orders', 'no-received'])).toEqual({
    runs: params.numRuns,
    discards: 0,
    thin: [],
  });
}, 120_000);

it('[AC-B2-11b#68] ⑧ 属性：算出的实际值经 decideAutoPayout 后，命中项恰为规则的精确比较（分子 × 10000 / 分母 > 阈值，0 不启用，分母 0 规则）', () => {
  const params = propParams();
  const stats = createPropStats('B2-11b:warn-decision');
  fc.assert(
    fc.property(sourceAndWarn, ({ source, warn }) => {
      stats.hit('run');
      for (const tier of tiersOf(source.withdrawn_30d_fen, source.received_60d_fen)) {
        stats.hit(tier);
      }
      const expected = expectedCodes(source, warn);
      stats.hit(expected.length === 0 ? 'miss' : 'hit');
      const value = passing();
      value.config.warn = { ...warn };
      value.warn_actuals = computeAutoPayoutWarnValues(source, warn);
      const decision = decideAutoPayout(value);
      return (
        isDeepStrictEqual(decision.failed_conditions, expected) &&
        decision.result === (expected.length === 0 ? 'auto' : 'manual') &&
        isDeepStrictEqual(decision.warn_values, value.warn_actuals)
      );
    }),
    params,
  );
  expect(summary(stats.flush(), [...TIERS, 'hit', 'miss'])).toEqual({
    runs: params.numRuns,
    discards: 0,
    thin: [],
  });
}, 120_000);

it('[AC-B2-11b#69] ⑨ 属性：platform_daily_max_fen=0 时任何 ≥1 分的金额、任何当日已自动合计都记 platform_daily_max（D10-377）', () => {
  const params = propParams();
  const stats = createPropStats('B2-11b:platform-zero');
  fc.assert(
    fc.property(positiveFen, fen, (amount, existing) => {
      stats.hit('run');
      for (const tier of tiersOf(amount, existing)) stats.hit(tier);
      const value = passing();
      value.amount_fen = amount;
      value.frozen_fen = amount;
      value.config = { ...defaults(), enabled: 'on', max_amount_fen: amount };
      value.platform_daily_auto_fen = existing;
      value.config.platform_daily_max_fen = 0n;
      const decision = decideAutoPayout(value);
      return (
        decision.result === 'manual' &&
        isDeepStrictEqual(decision.failed_conditions, ['platform_daily_max'])
      );
    }),
    params,
  );
  expect(summary(stats.flush(), TIERS)).toEqual({ runs: params.numRuns, discards: 0, thin: [] });
}, 120_000);
