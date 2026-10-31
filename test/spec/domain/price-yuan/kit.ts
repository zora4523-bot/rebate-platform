import { parseYuanToFen } from '@couli/domain';

// BR-PRICE-01 / D10-515 ①: fen fields are int64; anything above this is a missing field.
export const INT64_MAX = 9223372036854775807n;

/** Runtime-defence calls with non-string arguments (the TS signature stays `string`). */
export const parseUnknown = parseYuanToFen as (value: unknown) => bigint | null;

/** What happened on one call: a returned value, or the message of whatever was thrown. */
export type Outcome = { readonly returned: bigint | null } | { readonly threw: string };

export function outcomeOf(value: unknown): Outcome {
  try {
    return { returned: parseUnknown(value) };
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Independent oracle written straight from D10-515 ①: full match of ^[0-9]+(\.[0-9]{1,2})?$,
 * integer part × 100 + fraction padded to two digits, null above int64. Test-only.
 */
export function expectedFen(text: string): bigint | null {
  const match = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(text);
  if (match === null || match[0] !== text) return null;
  const whole = match[1] ?? '';
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const fen = BigInt(whole) * 100n + BigInt(fraction);
  return fen > INT64_MAX ? null : fen;
}
