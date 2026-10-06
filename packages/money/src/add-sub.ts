// Integer-fen addition and subtraction (BR-CALC-01; BR-PRICE-09 net price is a subFen caller).
// Operands and results are bounded to the signed PG bigint (int64) range.

import { InvalidAmount } from './errors.ts';

const MIN_STORAGE_FEN = -9223372036854775808n;
const MAX_STORAGE_FEN = 9223372036854775807n;

/** Optional result constraint; signed operands are still allowed. */
export interface SubFenOptions {
  nonNegative?: boolean;
}

function assertStorageFen(value: unknown): asserts value is bigint {
  if (typeof value !== 'bigint') throw new InvalidAmount('Amount must be bigint fen');
  if (value < MIN_STORAGE_FEN || value > MAX_STORAGE_FEN) {
    throw new InvalidAmount('Amount exceeds the PG bigint range');
  }
}

function checkedResult(fen: bigint): bigint {
  if (fen < MIN_STORAGE_FEN || fen > MAX_STORAGE_FEN) {
    throw new InvalidAmount('Result exceeds the PG bigint range');
  }
  return fen;
}

/** Read nonNegative strictly: anything other than undefined / true / false is a caller bug. */
function wantsNonNegative(options: unknown): boolean {
  if (options === undefined) return false;
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('subFen options must be an object');
  }
  const flag = (options as { nonNegative?: unknown }).nonNegative;
  if (flag === undefined) return false;
  if (typeof flag !== 'boolean') throw new TypeError('subFen nonNegative must be a boolean');
  return flag;
}

/** Add signed bigint fen. Operands and result must fit PG int64, else InvalidAmount. */
export function addFen(left_fen: bigint, right_fen: bigint): bigint {
  assertStorageFen(left_fen);
  assertStorageFen(right_fen);
  return checkedResult(left_fen + right_fen);
}

/**
 * Subtract signed bigint fen within PG int64; invalid operands/results throw InvalidAmount.
 * Negative results are allowed unless options.nonNegative is true (then InvalidAmount).
 * The 2^53-1 JSON limit belongs to fenToJsonNumber, not this bigint arithmetic API.
 * Operands are validated before options, so a bad amount always reports InvalidAmount.
 */
export function subFen(left_fen: bigint, right_fen: bigint, options?: SubFenOptions): bigint {
  assertStorageFen(left_fen);
  assertStorageFen(right_fen);
  const nonNegative = wantsNonNegative(options);
  const result = checkedResult(left_fen - right_fen);
  if (nonNegative && result < 0n) throw new InvalidAmount('Result must be non-negative');
  return result;
}
