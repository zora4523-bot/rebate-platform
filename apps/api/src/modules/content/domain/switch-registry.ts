// Task F1-10b: registry of the emergency switches of 规划/04 §10.2 (server side, effective within
// 10 seconds; changing one needs step-up and raises an alert), as pure data plus lookups. The
// registry only describes the switches (value type, default for the admin list, permission points
// of 04 §11.2, whether the admin console may change it); reading a switch's value still goes
// through ContentReader.configValue, and no reader's handling of a missing value changes here.
//
// Key patterns: a placeholder `<platform>`, `<channel>`, `<pay_channel>` or `<name>` stands for
// exactly one segment of lowercase letters, digits and underscores; every other segment matches
// literally. Lookups never infer a switch from a prefix.

/** Admin permission points that may change an emergency switch (规划/04 §11.2). */
export type SwitchPermission = 'switch.all' | 'switch.payout' | 'switch.pay';

/** The JSON shape a switch's config_items value takes. */
export type SwitchValueType =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'object' };

/**
 * A default as written in the 04 §10.2 default column: true for on / false, false for off /
 * false, an enum value for an enum; null where the column leaves it undecided
 * (「on / off」, 「见 BR-PROD-10 细则」) and for every object-valued switch (agent.model_route).
 */
export type SwitchDefault = boolean | string | null;

/** One registered switch: a literal key or a key pattern with one placeholder segment. */
export interface SwitchSpec {
  /** The key or key pattern as written in 04 §10.2, e.g. `convert.enabled.<platform>`. */
  readonly pattern: string;
  readonly valueType: SwitchValueType;
  /** Default of every key of this pattern whose placeholder value is not in defaultOverrides. */
  readonly defaultValue: SwitchDefault;
  /**
   * Defaults that 04 §10.2 fixes per placeholder value (placeholder value → default); empty for
   * literal keys and for patterns without per-value defaults.
   */
  readonly defaultOverrides: Readonly<Record<string, SwitchDefault>>;
  /** Permission points of 04 §11.2, any one of which allows the change. */
  readonly permissions: readonly SwitchPermission[];
  /** false: the admin console may not change it yet (registered for listing only). */
  readonly adminEditable: boolean;
  /**
   * true: the system also writes this switch itself, and such writes must go through the same
   * version comparison and change history as admin writes.
   */
  readonly systemWritten: boolean;
}

/** Every registered switch, one entry per key or key pattern of 04 §10.2. */
export function switchRegistry(): readonly SwitchSpec[] {
  throw new Error('NotImplemented: switchRegistry');
}

/** The registered switch `key` belongs to, or null when `key` is not an emergency switch. */
export function switchSpecOf(key: string): SwitchSpec | null {
  void key;
  throw new Error('NotImplemented: switchSpecOf');
}
