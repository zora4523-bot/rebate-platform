// Task F1-10e: registry of the configuration items the admin console lists and changes
// (规划/04 §10, §11.2; orchestrator ruling 14), as pure data plus lookups. Disjoint from the
// emergency switch registry (./switch-registry.ts): a switch key is never a configuration item.
// Every key is literal (no patterns); lookups never infer an item from a prefix.

/** Admin permission points that guard changing a configuration item (规划/04 §11.2). */
export type ConfigPermission = 'config.general' | 'config.risk' | 'config.business';

/** The contract's AdminConfigValueType. */
export type ConfigValueType = 'boolean' | 'enum' | 'object' | 'number' | 'string';

/** One registered configuration item. */
export interface ConfigItemSpec {
  readonly key: string;
  readonly valueType: ConfigValueType;
  /** Allowed values when valueType is enum; null for every other type. */
  readonly options: readonly string[] | null;
  /** The one point that guards changing it, and so its step-up tier. */
  readonly permission: ConfigPermission;
  /** false: listed read only, a change is 20001 [key]. */
  readonly adminEditable: boolean;
}

function spec(
  key: string,
  valueType: ConfigValueType,
  permission: ConfigPermission,
  adminEditable = true,
): ConfigItemSpec {
  return Object.freeze({ key, valueType, options: null, permission, adminEditable });
}

// F1-10e ruling 14: explicit entries, including the read-only money-rule flags.
const REGISTRY: readonly ConfigItemSpec[] = Object.freeze([
  spec('withdraw.payout_account_verify_per_day', 'number', 'config.business'),
  spec('withdraw.payout_account_verify_inflight_timeout_sec', 'number', 'config.business'),
  spec('withdraw.payout_account_verify_recheck_minutes', 'number', 'config.business'),
  spec('withdraw.payout_account_verify_reuse_hours', 'number', 'config.business'),
  spec('rebate.pdd.compare_precheck.enabled', 'boolean', 'config.business'),
  spec('settle.estimate_change_diff.enabled', 'boolean', 'config.business', false),
  spec('settle.adjust.void_on_clawback.enabled', 'boolean', 'config.business', false),
  spec('order_sync.regression_hold.enabled', 'boolean', 'config.business', false),
  spec('order_sync.unmapped_status_hold.enabled', 'boolean', 'config.business', false),
  spec('ledger.bad_debt_require_no_frozen.enabled', 'boolean', 'config.business', false),
  spec('payout.proven_success_writeoff.enabled', 'boolean', 'config.business', false),
  spec('risk.merge_tombstone_dedupe', 'boolean', 'config.risk'),
  spec('auth.oauth_attempt_ttl_sec', 'number', 'config.risk'),
  spec('push.token_conflict_window_hours', 'number', 'config.risk'),
  spec('attr.track_complete_tolerance_sec', 'number', 'config.risk'),
  spec('external_page.union_host_block', 'boolean', 'config.risk'),
  spec('union.taobao.auth_methods.ios', 'object', 'config.general'),
  spec('union.taobao.auth_methods.android', 'object', 'config.general'),
  spec('union.taobao.auth_methods.harmony', 'object', 'config.general'),
  spec('external_page.nav_host_sample_bp', 'number', 'config.general'),
  spec('share.open_in_app.enabled', 'boolean', 'config.general'),
  spec('invite.bind_phone_guide', 'boolean', 'config.general'),
  spec('invite.before_buy_tip', 'boolean', 'config.general'),
  spec('earnings.dashboard.enabled', 'boolean', 'config.general'),
  spec('earnings.dashboard.referral_visible', 'boolean', 'config.general'),
  spec('order.user_query_months', 'number', 'config.general'),
  spec('app_update.recheck_interval_sec', 'number', 'config.general'),
  spec('agent.page_guide.routes', 'object', 'config.general', false),
  spec('external_hosts', 'object', 'config.general', false),
]);

const BY_KEY = new Map(REGISTRY.map((entry) => [entry.key, entry]));

/** Every registered configuration item, in registry (list) order. */
export function configRegistry(): readonly ConfigItemSpec[] {
  return REGISTRY;
}

/** The registered item `key` names, or null when it is not a configuration item. */
export function configItemSpecOf(key: string): ConfigItemSpec | null {
  return BY_KEY.get(key) ?? null;
}

/** Whether `value` is of the item's registered type (an enum value must be one of options). */
export function configValueFits(spec: ConfigItemSpec, value: unknown): boolean {
  switch (spec.valueType) {
    case 'enum':
      return typeof value === 'string' && (spec.options?.includes(value) ?? false);
    case 'object':
      return typeof value === 'object' && value !== null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
  }
}
