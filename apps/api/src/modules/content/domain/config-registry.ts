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

/** Every registered configuration item, in registry (list) order. */
export function configRegistry(): readonly ConfigItemSpec[] {
  throw new Error('NotImplemented: configRegistry');
}

/** The registered item `key` names, or null when it is not a configuration item. */
export function configItemSpecOf(key: string): ConfigItemSpec | null {
  void key;
  throw new Error('NotImplemented: configItemSpecOf');
}

/** Whether `value` is of the item's registered type (an enum value must be one of options). */
export function configValueFits(spec: ConfigItemSpec, value: unknown): boolean {
  void spec;
  void value;
  throw new Error('NotImplemented: configValueFits');
}
