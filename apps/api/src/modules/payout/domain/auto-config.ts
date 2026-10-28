// B2-11d: the two configuration gates of 规划/08 BR-WDR-30 owned by payout, as pure functions over
// config_items values (full key → JSON value; an absent key takes its 08 default):
//   autoPayoutSaveRefusals  保存时校验 on the configuration as it would be after the save:
//     ② max_amount_fen ≤ withdraw.max_amount_fen; ③ window_end > window_start;
//     ⑨ platform_daily_max_fen ≤ payout.daily_cap_fen; ⑫ risk_block_flags only BR-WDR-29 label
//     codes (the real-time blacklist_hit check is fixed and does not depend on the set);
//     the refused keys come in the order ② ③ ⑨ ⑫, none when the configuration may be saved;
//   checkAutoPayoutEnable  开启前置检查 before withdraw.auto_payout.enabled is turned on:
//     BR-WDR-22 ② ⑤ ⑧ judged supported in 规划/09 (three boolean keys, default false) and the
//     daily channel reconciliation (BR-WDR-23) run through for at least the days the owner set
//     (recon_required_days, unset by default); the days run through are a fact read through a
//     port, never a configuration key (编排裁定 D10-392). Every item is listed, and an unset
//     item does not pass.

import { InvalidAmount, parseFen, subFen } from '@couli/money';

import { RISK_LABEL_ORDER } from './auto-decision.ts';

/** A key the BR-WDR-30 save check refuses. */
export type AutoPayoutSaveRefusal =
  | 'withdraw.auto_payout.max_amount_fen'
  | 'withdraw.auto_payout.window_end'
  | 'withdraw.auto_payout.platform_daily_max_fen'
  | 'withdraw.auto_payout.risk_block_flags';

/** The configuration keys the enable precheck reads (filled by the owner when enabling). */
export type AutoPayoutEnableKey =
  | 'payout.auto_enable_check.limits_supported'
  | 'payout.auto_enable_check.status_codes_supported'
  | 'payout.auto_enable_check.bill_out_biz_no_supported'
  | 'payout.auto_enable_check.recon_required_days';

/** One precheck item: BR-WDR-22 ②, ⑤, ⑧, then the BR-WDR-23 reconciliation days. */
export type AutoPayoutEnableItemCode =
  'limits_supported' | 'status_codes_supported' | 'bill_out_biz_no_supported' | 'recon_days';

export interface AutoPayoutEnableItem {
  readonly code: AutoPayoutEnableItemCode;
  readonly passed: boolean;
}

export interface AutoPayoutEnableCheck {
  /** true only when every item passed. */
  readonly passed: boolean;
  /** Every item, in AutoPayoutEnableItemCode order. */
  readonly items: readonly AutoPayoutEnableItem[];
}

const MAX = 'withdraw.auto_payout.max_amount_fen';
const WITHDRAW_MAX = 'withdraw.max_amount_fen';
const WINDOW_START = 'withdraw.auto_payout.window_start';
const WINDOW_END = 'withdraw.auto_payout.window_end';
const PLATFORM_MAX = 'withdraw.auto_payout.platform_daily_max_fen';
const DAILY_CAP = 'payout.daily_cap_fen';
const BLOCK_FLAGS = 'withdraw.auto_payout.risk_block_flags';

/**
 * The 08 default of every key the save check reads (BR-WDR-04 / BR-WDR-22 / BR-WDR-30 细则; the
 * same values as the readers' defaults: DEFAULT_WITHDRAW_LIMITS, AUTO_PAYOUT_DEFAULTS and
 * judgement's payout.daily_cap_fen, kept equal by application/auto-config.test.ts).
 */
export const AUTO_PAYOUT_SAVE_DEFAULTS: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  [MAX, 30000],
  [WITHDRAW_MAX, 500000],
  [WINDOW_START, '09:00:00'],
  [WINDOW_END, '22:59:59'],
  [PLATFORM_MAX, 200000],
  [DAILY_CAP, 5000000],
  [
    BLOCK_FLAGS,
    [
      'same_device_multi_account',
      'had_negative',
      'recon_diff',
      'payee_prev_other_user',
      'risk_calc_failed',
    ],
  ],
]);

/** Every key the save check reads: a write to any other key never changes its answer. */
export const AUTO_PAYOUT_SAVE_KEYS: readonly string[] = [...AUTO_PAYOUT_SAVE_DEFAULTS.keys()];

/** Each refusal with the keys whose values it compares, the refused key first. */
const SAVE_RULES: ReadonlyArray<readonly [AutoPayoutSaveRefusal, readonly string[]]> = [
  [MAX, [MAX, WITHDRAW_MAX]],
  [WINDOW_END, [WINDOW_END, WINDOW_START]],
  [PLATFORM_MAX, [PLATFORM_MAX, DAILY_CAP]],
  [BLOCK_FLAGS, [BLOCK_FLAGS]],
];

const HMS = /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;
const LABEL_CODES: ReadonlySet<string> = new Set(RISK_LABEL_ORDER);

function valueOf(values: ReadonlyMap<string, unknown>, key: string): unknown {
  return values.has(key) ? values.get(key) : AUTO_PAYOUT_SAVE_DEFAULTS.get(key);
}

/** limit ≤ bound as integer fen; a value that is not a JSON integer fails (fail-closed). */
function withinFen(limit: unknown, bound: unknown): boolean {
  if (typeof limit !== 'number' || typeof bound !== 'number') return false;
  try {
    return subFen(parseFen(bound), parseFen(limit)) >= 0n;
  } catch (error) {
    if (error instanceof InvalidAmount) return false;
    throw error;
  }
}

/** end > start, both 'HH:MM:SS' (fixed width, so string order is time order). */
function endAfterStart(start: unknown, end: unknown): boolean {
  return (
    typeof start === 'string' &&
    typeof end === 'string' &&
    HMS.test(start) &&
    HMS.test(end) &&
    end > start
  );
}

function labelCodes(flags: unknown): boolean {
  return (
    Array.isArray(flags) &&
    flags.every((code: unknown) => typeof code === 'string' && LABEL_CODES.has(code))
  );
}

function refused(rule: AutoPayoutSaveRefusal, values: ReadonlyMap<string, unknown>): boolean {
  switch (rule) {
    case MAX:
      return !withinFen(valueOf(values, MAX), valueOf(values, WITHDRAW_MAX));
    case WINDOW_END:
      return !endAfterStart(valueOf(values, WINDOW_START), valueOf(values, WINDOW_END));
    case PLATFORM_MAX:
      return !withinFen(valueOf(values, PLATFORM_MAX), valueOf(values, DAILY_CAP));
    case BLOCK_FLAGS:
      return !labelCodes(valueOf(values, BLOCK_FLAGS));
  }
}

export function autoPayoutSaveRefusals(
  values: ReadonlyMap<string, unknown>,
): AutoPayoutSaveRefusal[] {
  return SAVE_RULES.filter(([rule]) => refused(rule, values)).map(([rule]) => rule);
}

/**
 * The save check of one write (a single update, a batch or a rollback): `stored` are the caller's
 * current rows of AUTO_PAYOUT_SAVE_KEYS (absent = unset), `written` the values the write sets.
 * Returns the written keys to refuse: for every rule the configuration after the write breaks,
 * its refused key when written, else the other written key it compares (lowering
 * payout.daily_cap_fen below platform_daily_max_fen refuses payout.daily_cap_fen). A rule none of
 * whose keys is written is not this write's doing and does not refuse it.
 */
export function autoPayoutWriteRefusals(
  stored: ReadonlyMap<string, unknown>,
  written: ReadonlyMap<string, unknown>,
): string[] {
  const after = new Map(stored);
  for (const [key, value] of written) after.set(key, value);
  const fields: string[] = [];
  for (const [rule, keys] of SAVE_RULES) {
    const key = keys.find((candidate) => written.has(candidate));
    if (key !== undefined && refused(rule, after) && !fields.includes(key)) fields.push(key);
  }
  return fields;
}

/**
 * `values`: the AutoPayoutEnableKey values (full key → JSON value, an unset key absent);
 * `reconPassedDays`: the consecutive days the daily channel reconciliation has run through.
 */
export function checkAutoPayoutEnable(
  values: ReadonlyMap<string, unknown>,
  reconPassedDays: number,
): AutoPayoutEnableCheck {
  const required = values.get('payout.auto_enable_check.recon_required_days');
  const supported = (key: AutoPayoutEnableKey) => values.get(key) === true;
  const items: AutoPayoutEnableItem[] = [
    { code: 'limits_supported', passed: supported('payout.auto_enable_check.limits_supported') },
    {
      code: 'status_codes_supported',
      passed: supported('payout.auto_enable_check.status_codes_supported'),
    },
    {
      code: 'bill_out_biz_no_supported',
      passed: supported('payout.auto_enable_check.bill_out_biz_no_supported'),
    },
    {
      code: 'recon_days',
      // Unset, or not a positive integer, never passes; the days run through must reach it.
      passed:
        typeof required === 'number' &&
        Number.isSafeInteger(required) &&
        required >= 1 &&
        Number.isSafeInteger(reconPassedDays) &&
        reconPassedDays >= required,
    },
  ];
  return { passed: items.every((item) => item.passed), items };
}
