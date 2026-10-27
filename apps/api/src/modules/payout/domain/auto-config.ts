// B2-11d: the two configuration gates of 规划/08 BR-WDR-30 owned by payout, as pure functions over
// config_items values (full key → JSON value; an absent key takes its 08 default):
//   autoPayoutSaveRefusals  保存时校验 on the configuration as it would be after the save:
//     ② max_amount_fen ≤ withdraw.max_amount_fen; ③ window_end > window_start;
//     ⑨ platform_daily_max_fen ≤ payout.daily_cap_fen; ⑫ risk_block_flags only BR-WDR-29 label
//     codes (the real-time blacklist_hit check is fixed and does not depend on the set);
//     the refused keys come in the order ② ③ ⑨ ⑫, none when the configuration may be saved;
//   checkAutoPayoutEnable  开启前置检查 before withdraw.auto_payout.enabled is turned on:
//     BR-WDR-22 ② ⑤ ⑧ judged supported in 规划/09 and the daily channel reconciliation
//     (BR-WDR-23) run through for the days the owner set, all registered under
//     payout.auto_enable_check.*; every item is listed, and an unregistered item does not pass.

/** A key the BR-WDR-30 save check refuses. */
export type AutoPayoutSaveRefusal =
  | 'withdraw.auto_payout.max_amount_fen'
  | 'withdraw.auto_payout.window_end'
  | 'withdraw.auto_payout.platform_daily_max_fen'
  | 'withdraw.auto_payout.risk_block_flags';

/** The configuration keys the enable precheck reads (registered by the owner when enabling). */
export type AutoPayoutEnableKey =
  | 'payout.auto_enable_check.limits_supported'
  | 'payout.auto_enable_check.status_codes_supported'
  | 'payout.auto_enable_check.bill_out_biz_no_supported'
  | 'payout.auto_enable_check.recon_required_days'
  | 'payout.auto_enable_check.recon_passed_days';

/** One precheck item: BR-WDR-22 ②, ⑤, ⑧, then the BR-WDR-23 reconciliation days. */
export type AutoPayoutEnableItemCode =
  | 'limits_supported'
  | 'status_codes_supported'
  | 'bill_out_biz_no_supported'
  | 'recon_days';

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

export function autoPayoutSaveRefusals(
  values: ReadonlyMap<string, unknown>,
): AutoPayoutSaveRefusal[] {
  void values;
  throw new Error('NotImplemented: autoPayoutSaveRefusals');
}

export function checkAutoPayoutEnable(values: ReadonlyMap<string, unknown>): AutoPayoutEnableCheck {
  void values;
  throw new Error('NotImplemented: checkAutoPayoutEnable');
}
