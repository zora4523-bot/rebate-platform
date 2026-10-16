/**
 * BR-CALC-01 / BR-CALC-17: floor(amount_fen * a_bp * b_bp / 100000000), rounding once.
 * amount_fen must be a non-negative bigint (else InvalidAmount).
 * Each factor must independently be a bigint in 0..10000 (else InvalidRatio).
 */
export function mulBpBpFloor(amount_fen: bigint, a_bp: bigint, b_bp: bigint): bigint {
  void amount_fen;
  void a_bp;
  void b_bp;
  throw new Error('NotImplemented: mulBpBpFloor');
}
