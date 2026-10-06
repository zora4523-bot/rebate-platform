/** Optional result constraint; signed operands are still allowed. */
export interface SubFenOptions {
  nonNegative?: boolean;
}

/** Add signed bigint fen. Operands and result must fit PG int64, else InvalidAmount. */
export function addFen(left_fen: bigint, right_fen: bigint): bigint {
  void left_fen;
  void right_fen;
  throw new Error('NotImplemented: addFen');
}

/**
 * Subtract signed bigint fen within PG int64; invalid operands/results throw InvalidAmount.
 * Negative results are allowed unless options.nonNegative is true.
 * The 2^53-1 JSON limit belongs to fenToJsonNumber, not this bigint arithmetic API.
 */
export function subFen(left_fen: bigint, right_fen: bigint, options?: SubFenOptions): bigint {
  void left_fen;
  void right_fen;
  void options;
  throw new Error('NotImplemented: subFen');
}
