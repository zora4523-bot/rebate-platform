// @couli/money: integer-fen (bigint) amounts and basis-point ratios.
//
// SKELETON written by the rule-test author (规划/11 §2.3 step 3): every function only throws
// NotImplemented so that the rule tests in test/spec/money and test/properties/money go red on
// their assertions, not on a missing export. The implementer (task B2-01a) replaces the bodies
// and keeps the exported names, signatures and error classes exactly as declared here.
// Rules: 规划/08 BR-CALC-01, 02, 04, 07, 08, 21, 26 (text in the task brief).

/** Thrown for an amount that is not an integer number of fen, or is negative where forbidden. */
export class InvalidAmount extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAmount';
  }
}

/** Thrown for a ratio that is not a bigint in 0..10000 (basis points), or a bad sum of ratios. */
export class InvalidRatio extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRatio';
  }
}

/** Result of splitByBp: one floor amount per input ratio (same order) and what is left. */
export type SplitResult = {
  /** shares[i] = floor(base_fen * shares_bp[i] / 10000), each computed on its own. */
  shares: bigint[];
  /** base_fen - sum(shares); carries every rounding tail (platform retain). */
  remainder: bigint;
};

/** Result of applyReserve (BR-CALC-02, before any tlj_deduct_fen). */
export type ReserveResult = {
  /** floor(max(0, n_base_fen) * (10000 - reserve_bp) / 10000). */
  after_reserve_fen: bigint;
  /** max(0, n_base_fen) - after_reserve_fen; the rounding tail goes here (platform). */
  reserve_fen: bigint;
};

function notImplemented(name: string): never {
  throw new Error(`NotImplemented: ${name}`);
}

/**
 * Strict amount parser for values coming from JSON, the database driver or config.
 * - bigint: returned unchanged (any sign).
 * - number: only a safe integer (|n| <= 2^53 - 1) is accepted; fractions, NaN, Infinity and
 *   unsafe integers throw InvalidAmount.
 * - string: only a plain base-10 integer, optional leading "-" (e.g. "1452", "-320",
 *   "9007199254740993"); anything else ("", "1.5", "1e3", "0x10", " 12", "NaN") throws.
 * - any other type throws InvalidAmount.
 */
export function parseFen(value: unknown): bigint {
  void value;
  return notImplemented('parseFen');
}

/**
 * Canonical yuan string of an amount in fen: optional "-", integer yuan, ".", exactly two
 * digits (1452n -> "14.52", 5n -> "0.05", 0n -> "0.00", -320n -> "-3.20"). Not a UI display
 * format. Inverse of yuanStrToFen. A non-bigint argument throws InvalidAmount.
 */
export function formatFen(fen: bigint): string {
  void fen;
  return notImplemented('formatFen');
}

/**
 * BR-CALC-26: decimal yuan string -> fen, without ever going through a JS number.
 * Up to two decimals is exact ("14.5" -> 1450n, "14" -> 1400n, "-3.20" -> -320n); more than two
 * decimals is floored to the fen ("14.526" -> 1452n; floor means toward minus infinity, the
 * negative case is not covered by a rule test yet). Empty, non-numeric, scientific notation,
 * NaN / Infinity and non-string arguments throw InvalidAmount.
 */
export function yuanStrToFen(text: string): bigint {
  void text;
  return notImplemented('yuanStrToFen');
}

/**
 * BR-CALC-01 serialization: the JSON integer for an amount. Throws InvalidAmount when
 * |fen| > 2^53 - 1 (never loses precision silently) or when fen is not a bigint.
 */
export function fenToJsonNumber(fen: bigint): number {
  void fen;
  return notImplemented('fenToJsonNumber');
}

/**
 * BR-CALC-01 / BR-CALC-08: floor(amount_fen * ratio_bp / denominator), multiply first.
 * amount_fen must be a bigint >= 0 (else InvalidAmount); ratio_bp must be a bigint in 0..10000
 * (else InvalidRatio); denominator must be a positive bigint (callers pass 10000n).
 */
export function mulDivFloor(amount_fen: bigint, ratio_bp: bigint, denominator: bigint): bigint {
  void amount_fen;
  void ratio_bp;
  void denominator;
  return notImplemented('mulDivFloor');
}

/**
 * BR-CALC-04 / BR-CALC-08: split base_fen by basis points. Each share is floored on its own;
 * the remainder (platform) takes every tail. base_fen must be a bigint >= 0 (else
 * InvalidAmount); every ratio a bigint in 0..10000 and their sum <= 10000 (else InvalidRatio).
 * The input array is not modified.
 */
export function splitByBp(base_fen: bigint, shares_bp: readonly bigint[]): SplitResult {
  void base_fen;
  void shares_bp;
  return notImplemented('splitByBp');
}

/**
 * BR-CALC-02: platform reserve before the split. N_pos = max(0, n_base_fen) (a negative or zero
 * N gives 0 / 0); after_reserve_fen = floor(N_pos * (10000 - reserve_bp) / 10000);
 * reserve_fen = N_pos - after_reserve_fen. n_base_fen must be a bigint (else InvalidAmount);
 * reserve_bp a bigint in 0..10000 (else InvalidRatio).
 */
export function applyReserve(n_base_fen: bigint, reserve_bp: bigint): ReserveResult {
  void n_base_fen;
  void reserve_bp;
  return notImplemented('applyReserve');
}
