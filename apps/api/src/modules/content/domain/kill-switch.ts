// Task F1-10d: the admin console's view of one emergency switch (GET /admin/v1/kill-switches row
// fields that do not depend on the stored value) and the check of a requested change
// (PUT /admin/v1/kill-switches/{key}), as pure functions over the F1-10b registry
// (switch-registry.ts). Rule tests: test/spec/content/kill-switches/**.
import type { SwitchDefault, SwitchPermission } from './switch-registry.ts';

/** The contract's AdminConfigValueType values a registered switch can take. */
export type KillSwitchValueType = 'boolean' | 'enum' | 'object';

/** Registry facts of one concrete switch key, as the admin list shows them. */
export interface KillSwitchDescriptor {
  /** The concrete key, e.g. `convert.enabled.taobao` (never the pattern text). */
  readonly key: string;
  /** The pattern's default, or its per-placeholder override (defaultOverrides). */
  readonly default: SwitchDefault;
  readonly valueType: KillSwitchValueType;
  /** The allowed values of an enum switch; null for every other type. */
  readonly options: readonly string[] | null;
  /** Permission points of which any one may change the switch (04 §11.2). */
  readonly permissions: readonly SwitchPermission[];
  readonly adminEditable: boolean;
}

/** The request field a refused change is reported for (20001 data.fields). */
export type KillSwitchRefusal = 'key' | 'value';

/** The descriptor of `key`, or null when `key` is not a registered emergency switch. */
export function killSwitchDescriptor(key: string): KillSwitchDescriptor | null {
  void key;
  throw new Error('NotImplemented: killSwitchDescriptor');
}

/**
 * Why the console may not set `key` to `value`, or null when it may: 'key' when the key is not
 * registered or not admin-editable; 'value' when the value does not have the registered type (an
 * enum value outside its options included) or turns withdraw.auto_payout.enabled on (BR-WDR-30).
 */
export function killSwitchChangeRefusal(key: string, value: unknown): KillSwitchRefusal | null {
  void key;
  void value;
  throw new Error('NotImplemented: killSwitchChangeRefusal');
}
