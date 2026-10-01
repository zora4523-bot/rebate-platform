// int8 parsing for the pg driver (ADR-0001 §4.2 #3): amounts are bigint fen, so int8 and
// int8[] columns are returned as BigInt instead of pg's default strings. kysely-codegen maps
// both to bigint types (`--type-mapping` in scripts/snapshot.ts); the two must stay in step.

export type Int8ArrayValue = (bigint | null | Int8ArrayValue)[];

export function parseInt8(text: string): bigint {
  return BigInt(text);
}

/**
 * Parses PostgreSQL's text form of an int8 array, e.g. `{1,-2,NULL}` or `{{1,2},{3,4}}`.
 * A leading dimension decoration such as `[0:2]=` is ignored.
 */
export function parseInt8Array(text: string): Int8ArrayValue {
  const body = text.replace(/^(\[-?\d+:-?\d+\])+=/, '');
  if (!/^\{[-\d,{}NUL]*\}$/.test(body)) {
    throw new TypeError(`not an int8 array literal: ${text}`);
  }
  // Integer arrays never contain quotes or escapes, so the literal maps directly onto JSON.
  const json = body
    .replace(/-?\d+/g, '"$&"')
    .replace(/NULL/g, 'null')
    .replace(/\{/g, '[')
    .replace(/\}/g, ']');
  const convert = (value: unknown): bigint | null | Int8ArrayValue => {
    if (value === null) {
      return null;
    }
    if (typeof value === 'string') {
      return BigInt(value);
    }
    if (Array.isArray(value)) {
      return value.map(convert);
    }
    throw new TypeError(`not an int8 array literal: ${text}`);
  };
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new TypeError(`not an int8 array literal: ${text}`);
  }
  return parsed.map(convert);
}
