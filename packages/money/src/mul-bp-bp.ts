// Two-ratio floor for BR-CALC-17 (PDD self-buy quote): multiply both factors, floor once.

import { InvalidAmount, InvalidRatio } from './errors.ts';

const BP = 10000n;
const BP_SQUARED = BP * BP;

function assertNonNegativeAmount(value: unknown): asserts value is bigint {
  if (typeof value !== 'bigint') throw new InvalidAmount('Amount must be bigint fen');
  if (value < 0n) throw new InvalidAmount('Amount must be non-negative');
}

function assertRatio(value: unknown): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n || value > BP) {
    throw new InvalidRatio('Ratio must be bigint basis points in 0..10000');
  }
}

/**
 * BR-CALC-01 / BR-CALC-17: floor(amount_fen * a_bp * b_bp / 100000000), rounding once.
 * amount_fen must be a non-negative bigint (else InvalidAmount).
 * Each factor must independently be a bigint in 0..10000 (else InvalidRatio); the product of
 * the two factors is never passed through a single-ratio check or floored on its own.
 */
export function mulBpBpFloor(amount_fen: bigint, a_bp: bigint, b_bp: bigint): bigint {
  assertNonNegativeAmount(amount_fen);
  assertRatio(a_bp);
  assertRatio(b_bp);
  return (amount_fen * a_bp * b_bp) / BP_SQUARED;
}
