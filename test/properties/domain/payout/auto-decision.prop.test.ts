// B2-11b properties of decideAutoPayout (规划/08 BR-WDR-30 ①–⑬ and its 细则). The reference model
// below is written from the rule text, never from the implementation:
//   ① off → exactly ['disabled'];
//   otherwise, in this order, every failing code (no short-circuit):
//   ② max = 0 or amount > max; ③ window on and the +08:00 hh:mm:ss outside [start, end];
//   ④ limit on and first; ⑤ hold, frozen / appealing, or frozen_fen > amount; ⑥ credited_today;
//   ⑦ max ≠ 0 and existing + 1 > max; ⑧ Y / Z ≠ 0 and actual ≠ null and actual > Y / Z,
//   W ≠ 0 and (actual = null or actual > W); ⑨ existing + amount > platform max; ⑩ minor;
//   ⑪ channel off; ⑫ risk_flag:<code> for snapshot ∩ block set plus the real-time blacklist_hit,
//   in the BR-WDR-29 label order; ⑬ W2 guard;
//   result auto ⇔ no failing code; warn_values = the three ⑧ actual values.
// ⑨ with platform_daily_max_fen = 0 is not generated for a positive sum (细则 does not say what 0
// means there). Properties follow test/properties/README.md: boolean bodies, one summary assertion
// after fc.assert, amount tiers 0, 1, odd, > 2^31 each in at least 1% of the runs.
import { isDeepStrictEqual } from 'node:util';
import { createPropStats, propParams, type PropStatsRecord } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  decideAutoPayout,
  type AutoPayoutConfig,
  type AutoPayoutDecision,
  type AutoPayoutInput,
} from '../../../../apps/api/src/modules/payout/domain/auto-decision.ts';
import {
  DEFAULT_BLOCK_FLAGS,
  LABEL_ORDER,
  ORDER,
  SNAPSHOT_LABELS,
  failing,
  ordered,
  type Failable,
} from '../../../spec/payout/auto-decision/kit.ts';

const DAY = 86_400_000;
const OFFSET = 8 * 3_600_000;
const TWO_31 = 2n ** 31n;
const TIERS = ['zero', 'one', 'odd', 'above-2^31'] as const;
/** 2026-01-01 00:00 +08:00. */
const DAY0 = Date.UTC(2026, 0, 1) - OFFSET;

function tiersOf(fen: bigint): string[] {
  const hit: string[] = [];
  if (fen === 0n) hit.push('zero');
  if (fen === 1n) hit.push('one');
  if (fen % 2n === 1n) hit.push('odd');
  if (fen > TWO_31) hit.push('above-2^31');
  return hit;
}

function summary(record: PropStatsRecord, tiers: readonly string[]) {
  const runs = record.hits['run'] ?? 0;
  return {
    runs,
    discards: record.discards,
    thin: tiers.filter((tier) => (record.hits[tier] ?? 0) * 100 < runs),
  };
}

function secondsOf(hms: string): number {
  const [h, m, s] = hms.split(':').map(Number);
  return (h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function model(v: AutoPayoutInput): AutoPayoutDecision {
  const c = v.config;
  const out: string[] = [];
  if (c.enabled === 'off') out.push('disabled');
  else {
    if (c.max_amount_fen === 0n || v.amount_fen > c.max_amount_fen) out.push('max_amount');
    if (c.window_limit_enabled === 'on') {
      // The +08:00 wall clock in whole seconds (milliseconds dropped); created_at is after 1970.
      const sec = Math.floor(((v.created_at.getTime() + OFFSET) % DAY) / 1000);
      if (sec < secondsOf(c.window_start) || sec > secondsOf(c.window_end)) {
        out.push('outside_window');
      }
    }
    if (c.first_withdrawal_limit_enabled === 'on' && v.first_withdrawal) {
      out.push('first_withdrawal');
    }
    if (
      v.active_hold ||
      v.risk_state === 'frozen' ||
      v.risk_state === 'appealing' ||
      v.frozen_fen > v.amount_fen
    ) {
      out.push('frozen_balance');
    }
    if (v.credited_today) out.push('same_day');
    const over = (existing: number, max: number) => max !== 0 && existing + 1 > max;
    if (over(v.counts.payee_daily, c.payee_daily_max_count)) out.push('payee_daily_count');
    if (over(v.counts.payee_monthly, c.payee_monthly_max_count)) out.push('payee_monthly_count');
    if (over(v.counts.user_daily, c.user_daily_max_count)) out.push('user_daily_count');
    if (over(v.counts.user_monthly, c.user_monthly_max_count)) out.push('user_monthly_count');
    const a = v.warn_actuals;
    const y = c.warn.high_commission_order_ratio_bp;
    const high = a.high_commission_order_ratio_bp;
    if (y !== 0 && high !== null && high > y) out.push('warn_high_commission');
    const z = c.warn.invalid_ratio_bp;
    if (z !== 0 && a.invalid_ratio_bp !== null && a.invalid_ratio_bp > z) {
      out.push('warn_invalid_ratio');
    }
    const w = c.warn.withdraw_received_ratio_bp;
    if (w !== 0 && (a.withdraw_received_ratio_bp === null || a.withdraw_received_ratio_bp > w)) {
      out.push('warn_withdraw_received');
    }
    if (v.platform_daily_auto_fen + v.amount_fen > c.platform_daily_max_fen) {
      out.push('platform_daily_max');
    }
    if (!v.adult) out.push('minor');
    if (!v.channel_enabled) out.push('channel_disabled');
    const snapshot = new Set(v.risk_flags.map((flag) => flag.code));
    const block = new Set(c.risk_block_flags);
    for (const code of LABEL_ORDER) {
      const hit =
        code === 'blacklist_hit' ? v.blacklist_hit : snapshot.has(code) && block.has(code);
      if (hit) out.push(`risk_flag:${code}`);
    }
    if (!v.w2_guard_passed) out.push('w2_guard');
  }
  return {
    result: out.length === 0 ? 'auto' : 'manual',
    failed_conditions: out as AutoPayoutDecision['failed_conditions'],
    warn_values: { ...v.warn_actuals },
  };
}

const fen = fc.oneof(
  fc.constantFrom(0n, 1n),
  fc.bigInt({ min: 0n, max: 10n ** 6n }).map((v) => 2n * v + 1n),
  fc.bigInt({ min: TWO_31 + 1n, max: 10n ** 15n }),
  fc.bigInt({ min: 0n, max: 10n ** 12n }),
);
const onOff = fc.constantFrom(...(['off', 'on'] as const));
const count = fc.integer({ min: 0, max: 4 });
const bp = fc.oneof(
  fc.constantFrom(0, 1, 3000, 5000, 9999, 10000),
  fc.integer({ min: 0, max: 10000 }),
);
const actual = fc.option(
  fc.oneof(
    fc.constantFrom(0, 1, 3000, 3001, 5000, 5001, 10000, 10001),
    fc.integer({ min: 0, max: 30000 }),
  ),
  { nil: null },
);

/** An arbitrary BR-WDR-30 input, edges of ② ③ ⑤ ⑦ ⑧ ⑨ over-represented. */
const anyInput: fc.Arbitrary<AutoPayoutInput> = fc
  .record({
    enabled: onOff,
    amount: fen,
    maxMode: fc.constantFrom(...(['equal', 'below', 'zero', 'random'] as const)),
    maxRandom: fen,
    hours: fc.tuple(fc.integer({ min: 9, max: 22 }), fc.integer({ min: 9, max: 22 })),
    windowLimit: onOff,
    timeMode: fc.constantFrom(...(['start', 'start-1', 'end', 'end+1', 'random'] as const)),
    secondOfDay: fc.integer({ min: 0, max: 86_399 }),
    milli: fc.oneof(fc.constantFrom(0, 999), fc.integer({ min: 0, max: 999 })),
    day: fc.integer({ min: 0, max: 3650 }),
    firstLimit: onOff,
    first: fc.boolean(),
    hold: fc.boolean(),
    riskState: fc.constantFrom(...(['normal', 'frozen', 'banned', 'appealing'] as const)),
    frozenMode: fc.constantFrom(...(['equal', 'plus1', 'zero', 'random'] as const)),
    frozenRandom: fen,
    credited: fc.boolean(),
    maxCounts: fc.tuple(count, count, count, count),
    counts: fc.tuple(count, count, count, count),
    warn: fc.tuple(bp, bp, bp, bp),
    actuals: fc.tuple(actual, actual, actual),
    platformExisting: fen,
    platformMode: fc.constantFrom(...(['equal', 'over', 'random'] as const)),
    platformRandom: fen,
    adult: fc.boolean(),
    channel: fc.boolean(),
    snapshot: fc.uniqueArray(fc.constantFrom(...SNAPSHOT_LABELS)),
    block: fc.oneof(
      fc.constant<readonly string[]>(DEFAULT_BLOCK_FLAGS),
      fc.uniqueArray(fc.constantFrom(...LABEL_ORDER)),
    ),
    blacklist: fc.boolean(),
    guard: fc.boolean(),
  })
  .map((g) => {
    const [startHour, endHour]: [number, number] =
      g.hours[0] <= g.hours[1] ? g.hours : [g.hours[1], g.hours[0]];
    const start = `${pad(startHour)}:00:00`;
    const end = `${pad(endHour)}:59:59`;
    const second = {
      start: secondsOf(start),
      'start-1': secondsOf(start) - 1,
      end: secondsOf(end),
      'end+1': secondsOf(end) + 1,
      random: g.secondOfDay,
    }[g.timeMode];
    const maxAmount = {
      equal: g.amount,
      below: g.amount > 0n ? g.amount - 1n : 0n,
      zero: 0n,
      random: g.maxRandom,
    }[g.maxMode];
    const frozen = {
      equal: g.amount,
      plus1: g.amount + 1n,
      zero: 0n,
      random: g.frozenRandom,
    }[g.frozenMode];
    const sum = g.platformExisting + g.amount;
    let platformMax = {
      equal: sum,
      over: sum > 0n ? sum - 1n : 0n,
      random: g.platformRandom,
    }[g.platformMode];
    if (platformMax === 0n && sum > 0n) platformMax = 1n;
    const config: AutoPayoutConfig = {
      enabled: g.enabled,
      max_amount_fen: maxAmount,
      window_start: start,
      window_end: end,
      window_limit_enabled: g.windowLimit,
      first_withdrawal_limit_enabled: g.firstLimit,
      frozen_balance_policy: 'no_auto',
      same_day_policy: 'no_auto',
      payee_daily_max_count: g.maxCounts[0],
      payee_monthly_max_count: g.maxCounts[1],
      user_daily_max_count: g.maxCounts[2],
      user_monthly_max_count: g.maxCounts[3],
      warn: {
        high_commission_rate_bp: g.warn[0],
        high_commission_order_ratio_bp: g.warn[1],
        invalid_ratio_bp: g.warn[2],
        withdraw_received_ratio_bp: g.warn[3],
      },
      platform_daily_max_fen: platformMax,
      risk_block_flags: [...g.block],
    };
    const input: AutoPayoutInput = {
      config,
      amount_fen: g.amount,
      created_at: new Date(DAY0 + g.day * DAY + second * 1000 + g.milli),
      first_withdrawal: g.first,
      active_hold: g.hold,
      risk_state: g.riskState,
      frozen_fen: frozen,
      credited_today: g.credited,
      counts: {
        payee_daily: g.counts[0],
        payee_monthly: g.counts[1],
        user_daily: g.counts[2],
        user_monthly: g.counts[3],
      },
      warn_actuals: {
        high_commission_order_ratio_bp: g.actuals[0],
        invalid_ratio_bp: g.actuals[1],
        withdraw_received_ratio_bp: g.actuals[2],
      },
      platform_daily_auto_fen: g.platformExisting,
      adult: g.adult,
      channel_enabled: g.channel,
      risk_flags: g.snapshot.map((code) => ({ code, value: 1, threshold: null })),
      blacklist_hit: g.blacklist,
      w2_guard_passed: g.guard,
    };
    return input;
  });

it('[AC-B2-11b#49] decideAutoPayout 属性：任意输入下与规则模型逐项一致（全部检查不短路，顺序 ①–⑬）', () => {
  const params = propParams();
  const stats = createPropStats('B2-11b:model');
  fc.assert(
    fc.property(anyInput, (value) => {
      stats.hit('run');
      for (const tier of tiersOf(value.amount_fen)) stats.hit(tier);
      return isDeepStrictEqual(decideAutoPayout(value), model(value));
    }),
    params,
  );
  expect(summary(stats.flush(), TIERS)).toEqual({ runs: params.numRuns, discards: 0, thin: [] });
}, 120_000);

it('[AC-B2-11b#50] decideAutoPayout 属性：failed_conditions 为空 ⇔ result=auto（任意不满足子集按 ①–⑬ 全列）', () => {
  const params = propParams();
  const stats = createPropStats('B2-11b:subset');
  const subset = fc.oneof(fc.constant<Failable[]>([]), fc.subarray([...ORDER]));
  fc.assert(
    fc.property(subset, fen, (codes, amount) => {
      stats.hit('run');
      for (const tier of tiersOf(amount)) stats.hit(tier);
      if (codes.length === 0) stats.hit('empty');
      const set = new Set(codes);
      const decision = decideAutoPayout(failing(set, amount));
      return (
        isDeepStrictEqual(decision.failed_conditions, ordered(set)) &&
        (decision.failed_conditions.length === 0) === (decision.result === 'auto')
      );
    }),
    params,
  );
  expect(summary(stats.flush(), [...TIERS, 'empty'])).toEqual({
    runs: params.numRuns,
    discards: 0,
    thin: [],
  });
}, 120_000);

it('[AC-B2-11b#51] decideAutoPayout 属性：任意输入下 ① off 时 failed_conditions 恰为 [disabled]、result=manual', () => {
  const params = propParams();
  const stats = createPropStats('B2-11b:disabled');
  fc.assert(
    fc.property(anyInput, (value) => {
      stats.hit('run');
      for (const tier of tiersOf(value.amount_fen)) stats.hit(tier);
      const decision = decideAutoPayout({ ...value, config: { ...value.config, enabled: 'off' } });
      return (
        decision.result === 'manual' && isDeepStrictEqual(decision.failed_conditions, ['disabled'])
      );
    }),
    params,
  );
  expect(summary(stats.flush(), TIERS)).toEqual({ runs: params.numRuns, discards: 0, thin: [] });
}, 120_000);

it('[AC-B2-11b#52] decideAutoPayout 属性：结果确定——重复调用相同、不改输入、与快照和阻断集合的顺序无关', () => {
  const params = propParams();
  const stats = createPropStats('B2-11b:deterministic');
  const shuffled = anyInput.chain((value) =>
    fc.tuple(
      fc.constant(value),
      fc.shuffledSubarray([...value.risk_flags], {
        minLength: value.risk_flags.length,
        maxLength: value.risk_flags.length,
      }),
      fc.shuffledSubarray([...value.config.risk_block_flags], {
        minLength: value.config.risk_block_flags.length,
        maxLength: value.config.risk_block_flags.length,
      }),
    ),
  );
  fc.assert(
    fc.property(shuffled, ([value, flags, block]) => {
      stats.hit('run');
      for (const tier of tiersOf(value.amount_fen)) stats.hit(tier);
      const before = structuredClone(value);
      const first = decideAutoPayout(value);
      const unchanged = isDeepStrictEqual(value, before);
      const again = decideAutoPayout(value);
      const permuted = decideAutoPayout({
        ...value,
        risk_flags: flags,
        config: { ...value.config, risk_block_flags: block },
      });
      return unchanged && isDeepStrictEqual(first, again) && isDeepStrictEqual(first, permuted);
    }),
    params,
  );
  expect(summary(stats.flush(), TIERS)).toEqual({ runs: params.numRuns, discards: 0, thin: [] });
}, 120_000);
