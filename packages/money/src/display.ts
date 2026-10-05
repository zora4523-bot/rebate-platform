// BR-TEXT-10 display formatting of integer fen (text and vectors in the task brief).
// Integer arithmetic on bigint only: no JS number, float, toFixed, Intl or toLocaleString,
// so the output never depends on the runtime locale.
import { InvalidAmount } from './errors.ts';

const MIN_INT64 = -9223372036854775808n;
const MAX_INT64 = 9223372036854775807n;
const RANGE_DASH = '–';

/** Same contract as the package's amount check, plus the signed int64 storage range. */
function assertDisplayAmount(value: unknown): asserts value is bigint {
  if (typeof value !== 'bigint') throw new InvalidAmount('Amount must be bigint fen');
  if (value < MIN_INT64 || value > MAX_INT64) {
    throw new InvalidAmount('Amount exceeds the PG bigint range');
  }
}

/** Sign prefix placed before '¥': '-' for negatives, '+' for positives when signed, else none. */
function signPrefix(fen: bigint, signed: boolean): string {
  if (fen < 0n) return '-';
  return signed && fen > 0n ? '+' : '';
}

/** App body (no sign): yuan, then at most two decimals with trailing zeros removed. */
function appBody(magnitude: bigint): string {
  const yuan = magnitude / 100n;
  const cent = magnitude % 100n;
  if (cent === 0n) return `¥${yuan}`;
  if (cent % 10n === 0n) return `¥${yuan}.${cent / 10n}`;
  return `¥${yuan}.${cent.toString().padStart(2, '0')}`;
}

/** Group a non-negative integer with ',' every three digits from the units place. */
function groupThousands(value: bigint): string {
  const digits = value.toString();
  const head = digits.length % 3 || 3;
  let out = digits.slice(0, head);
  for (let i = head; i < digits.length; i += 3) out += `,${digits.slice(i, i + 3)}`;
  return out;
}

/** Admin body (no sign): grouped yuan and exactly two decimals. */
function adminBody(magnitude: bigint): string {
  const cent = (magnitude % 100n).toString().padStart(2, '0');
  return `¥${groupThousands(magnitude / 100n)}.${cent}`;
}

/** BR-TEXT-10: App display of int64 bigint fen; signed adds '+' only for positives. */
export function formatYuan(fen: bigint, opts?: { signed?: boolean }): string {
  assertDisplayAmount(fen);
  const magnitude = fen < 0n ? -fen : fen;
  return signPrefix(fen, opts?.signed === true) + appBody(magnitude);
}

/** BR-TEXT-10: Admin display with two decimals and comma grouping. */
export function formatYuanAdmin(fen: bigint, opts?: { signed?: boolean }): string {
  assertDisplayAmount(fen);
  const magnitude = fen < 0n ? -fen : fen;
  return signPrefix(fen, opts?.signed === true) + adminBody(magnitude);
}

/**
 * BR-TEXT-10: Ordered nonnegative rebate range; zero/zero returns null (the caller shows the
 * "no rebate" dictionary text). min < max joins both ends with U+2013, min = max shows one
 * value. Non-bigint, out-of-int64, negative or min > max throw InvalidAmount.
 */
export function formatYuanRange(
  minFen: bigint,
  maxFen: bigint,
  opts?: { admin?: boolean },
): string | null {
  // Validate both ends before any equality or zero short circuit.
  assertDisplayAmount(minFen);
  assertDisplayAmount(maxFen);
  if (minFen < 0n || maxFen < 0n) throw new InvalidAmount('Rebate range must be non-negative');
  if (minFen > maxFen) throw new InvalidAmount('Rebate range min exceeds max');
  if (maxFen === 0n) return null;
  const body = opts?.admin === true ? adminBody : appBody;
  if (minFen === maxFen) return body(minFen);
  return `${body(minFen)}${RANGE_DASH}${body(maxFen)}`;
}
