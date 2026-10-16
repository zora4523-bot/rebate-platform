// F1-10d registry oracle without any database or HTTP import, shared by the unit rule tests
// (rules.test.ts) and the integration kit (kit.ts). Built on the frozen F1-10b kit
// (test/spec/content/switch-read/kit.ts), never on the implementation's registry.
import type { DB } from '@couli/db';
import { EXPECTED, type ExpectedSwitch } from '../switch-read/kit.ts';

export { EXPECTED, NOT_SWITCHES, SWITCH_EFFECTIVE_MS } from '../switch-read/kit.ts';
export type { ExpectedSwitch } from '../switch-read/kit.ts';

type Json = DB['config_items']['value'];

const PLACEHOLDER = /^<(platform|channel|pay_channel|name)>$/;

/** The expected registry row whose pattern `key` matches, or undefined for a non-switch key. */
export function expectedFor(key: string): { row: ExpectedSwitch; index: number } | undefined {
  const parts = key.split('.');
  for (const [index, row] of EXPECTED.entries()) {
    const segments = row.pattern.split('.');
    if (
      segments.length === parts.length &&
      segments.every((segment, i) =>
        PLACEHOLDER.test(segment)
          ? /^[a-z0-9_]+$/.test(parts[i] ?? '') && !(parts[i] ?? '').includes('\n')
          : segment === parts[i],
      )
    ) {
      return { row, index };
    }
  }
  return undefined;
}

function placeholderOf(row: ExpectedSwitch, key: string): string | undefined {
  const segments = row.pattern.split('.');
  const at = segments.findIndex((segment) => PLACEHOLDER.test(segment));
  return at < 0 ? undefined : key.split('.')[at];
}

/** The registry facts the list must show for the concrete `key`. */
export function staticFields(key: string) {
  const found = expectedFor(key);
  if (found === undefined) throw new Error(`kit: ${key} is not a registered switch`);
  const { row } = found;
  const placeholder = placeholderOf(row, key);
  const override =
    placeholder !== undefined && Object.hasOwn(row.defaultOverrides, placeholder)
      ? row.defaultOverrides[placeholder]
      : undefined;
  return {
    key,
    default: override === undefined ? row.defaultValue : override,
    value_type: row.valueType.kind,
    options: row.valueType.kind === 'enum' ? [...row.valueType.values] : null,
    permissions: [...row.permissions].sort(),
    admin_editable: row.adminEditable,
  };
}

/** Literal keys (no placeholder) of the registry, in registry order. */
export const LITERAL_KEYS = EXPECTED.filter((row) => !row.pattern.includes('<')).map(
  (row) => row.pattern,
);

/** Sample keys the console may change, one per registry row. */
export const EDITABLE_SAMPLES = EXPECTED.filter((row) => row.adminEditable).map(
  (row) => row.sample,
);

/** A value of the key's type, different from `current`, that the console may write. */
export function changedValue(key: string, current: Json | null): Json {
  const { row } = expectedFor(key)!;
  if (key === 'withdraw.auto_payout.enabled') return false;
  if (row.valueType.kind === 'enum') {
    return row.valueType.values.find((value) => value !== current) ?? row.valueType.values[0]!;
  }
  return current !== true;
}
