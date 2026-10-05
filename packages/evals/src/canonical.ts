// Canonical JSON and SHA-256, shared by the manifest digests (B3-01a) and the recording keys,
// report digest and smoke verdict (B3-01b), so that every digest in the package uses one rule.
import { createHash } from 'node:crypto';

/** Orders strings by UTF-16 code units (not `localeCompare`). */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Canonical compact JSON: object keys sorted by UTF-16 code units at every level, array order
 * kept, `undefined` members dropped (as JSON.stringify does). Built by hand so that integer-like
 * keys are not moved to the front by JavaScript's own property order. Non-finite numbers throw.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item: unknown) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort(compareCodeUnits);
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
  }
}

/** SHA-256 of the UTF-8 encoding of `text`, as lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
