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
 * A default as written in the 04 §10.2 default column: true for on, false for off /
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

const ALL: readonly SwitchPermission[] = Object.freeze(['switch.all']);
const PAYOUT: readonly SwitchPermission[] = Object.freeze(['switch.all', 'switch.payout']);
const PAY: readonly SwitchPermission[] = Object.freeze(['switch.all', 'switch.pay']);
const BOOLEAN: SwitchValueType = Object.freeze({ kind: 'boolean' });

/** Freeze every nested value as well as the entry: callers share this pure-data registry. */
function spec(
  pattern: string,
  defaultValue: SwitchDefault,
  permissions: readonly SwitchPermission[],
  options: {
    readonly valueType?: SwitchValueType;
    readonly defaultOverrides?: Readonly<Record<string, SwitchDefault>>;
    readonly adminEditable?: boolean;
    readonly systemWritten?: boolean;
  } = {},
): SwitchSpec {
  const valueType = options.valueType ?? BOOLEAN;
  return Object.freeze({
    pattern,
    valueType: Object.freeze(
      valueType.kind === 'enum'
        ? { kind: 'enum' as const, values: Object.freeze([...valueType.values]) }
        : { ...valueType },
    ),
    defaultValue,
    defaultOverrides: Object.freeze({ ...options.defaultOverrides }),
    permissions: Object.freeze([...permissions]),
    adminEditable: options.adminEditable ?? true,
    systemWritten: options.systemWritten ?? false,
  });
}

// 规划/04 §10.2 defaults and §11.2 permissions are recorded per key, never inferred by prefix.
const REGISTRY: readonly SwitchSpec[] = Object.freeze([
  spec('convert.enabled.<platform>', false, ALL),
  spec('convert.off_reason.<platform>', 'not_launched', ALL, {
    valueType: { kind: 'enum', values: ['not_launched', 'maintenance'] },
  }),
  spec('search.enabled.<platform>', null, ALL),
  spec('parse.tpwd.enabled', true, ALL),
  spec('pdd.direct_convert.enabled', false, ALL),
  spec('agent.enabled', true, ALL),
  // Enabling public access requires the registration-number check owned by the agent module.
  spec('agent.whitelist_only', true, ALL, { adminEditable: false }),
  // RouteSelection belongs to agent; the default-column label "primary" is not that object.
  spec('agent.model_route', null, ALL, {
    valueType: { kind: 'object' },
    adminEditable: false,
  }),
  spec('agent.tools.<name>.enabled', true, ALL),
  spec('agent.page_guide.enabled', true, ALL),
  spec('withdraw.enabled', true, PAYOUT),
  spec('withdraw.auto_payout.enabled', false, ALL),
  spec('payout.enabled', true, PAYOUT),
  // System writes also require the same version comparison and history as admin writes.
  spec('payout.queue_paused', false, PAYOUT, { systemWritten: true }),
  spec('payout.channel_enabled.<channel>', null, PAYOUT, {
    defaultOverrides: { alipay: true, bank_card: false, wechat: false },
  }),
  spec('payout.channel_paused.<channel>', false, PAYOUT, { systemWritten: true }),
  spec('pay.enabled', null, PAY),
  spec('pay.channel_enabled.<pay_channel>', null, PAY),
  spec('settle.auto.enabled', true, ALL, { systemWritten: true }),
  spec('credit.enabled.<platform>', false, ALL),
  spec('claims.enabled', true, ALL),
  spec('order_sync.promo_mode', false, ALL),
  spec('jev.enabled', false, ALL),
  spec('tlj.enabled', false, ALL),
  spec('growth.invite_bind.enabled', true, ALL),
  spec('watch.enabled.<platform>', false, ALL),
]);

const PLACEHOLDERS = new Set(['<platform>', '<channel>', '<pay_channel>', '<name>']);
const PATTERNS = REGISTRY.map((entry) => ({ entry, segments: entry.pattern.split('.') }));

/** Every registered switch, one entry per key or key pattern of 04 §10.2. */
export function switchRegistry(): readonly SwitchSpec[] {
  return REGISTRY;
}

/** The registered switch `key` belongs to, or null when `key` is not an emergency switch. */
export function switchSpecOf(key: string): SwitchSpec | null {
  const parts = key.split('.');
  for (const { entry, segments } of PATTERNS) {
    if (
      segments.length === parts.length &&
      segments.every((segment, index) => {
        const part = parts[index];
        if (!PLACEHOLDERS.has(segment)) return segment === part;
        // Reject every disallowed character, including a final newline (JS `$` permits it).
        return part !== undefined && part.length > 0 && !/[^a-z0-9_]/u.test(part);
      })
    ) {
      return entry;
    }
  }
  return null;
}
