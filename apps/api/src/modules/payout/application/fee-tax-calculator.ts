// B2-08c (规划/08 BR-WDR-20 税额计算与年度台账; 编排裁定 D10-456 ④; 拍板第二批 FUND-04): the tax of a
// withdrawal, computed at application from content's configuration — never a rate in code.
//
// Configuration (content's PayoutConfigPort, on the caller's handle; keys registered by B2-08cz):
//   tax.SERVICE_FEE.method      'none' | 'flat_rate' | 'cumulative'           missing → 'none'
//   tax.SERVICE_FEE.rate_bp     JSON integer 0..10000                           missing → 0
//   tax.SERVICE_FEE.rate_table  JSON array of brackets
//                               [{ from_fen, rate_bp, quick_deduction_fen }, …]  missing → []
//                               (every field a non-negative JSON integer, rate_bp ≤ 10000; the
//                               first from_fen is 0 and from_fen strictly ascends)
//   A missing row is its default silently; an invalid value is its default with a logger.warn
//   (key only), never a throw. The effective configuration is what remains after the defaults.
//
// Methods (amounts bigint fen, @couli/money; never floating point):
//   none        tax 0 (the state until the rate table arrives, FUND-04; tax_ytd still adds up).
//   flat_rate   round_half_up(amount × rate_bp / 10000).
//   cumulative  max(0, due(ytd income + in-flight amounts + amount) − ytd withheld − in-flight tax)
//               where due(X) = round_half_up(X × rate_bp / 10000) − quick_deduction_fen of the
//               bracket X falls in (the last bracket whose from_fen ≤ X; an empty table → 0);
//               ytd = the tax_ytd row (app, user, year, 'SERVICE_FEE', current identity hmac from
//               identity's realname-identity-key port; no row → 0 / 0; no verified real name →
//               0 / 0 and a logger.warn without any hmac); in-flight = the same member's
//               withdrawals, income_type 'SERVICE_FEE', status PENDING_REVIEW / APPROVED / PAYING,
//               whose created_at falls in the same +08:00 year: Σ amount_fen and Σ tax_fen.
//               year = the +08:00 calendar year of input.now (the instant the row is created at).
//   none and flat_rate read nothing but the three keys.
//
// fee_fen stays 0 (BR-WDR-19 MVP); net_fen = amount − fee − tax; tax_rule_version =
// taxRuleVersion(effective configuration): a deterministic, non-empty string that changes when the
// method, the rate or any bracket changes and is stable for the same configuration.
import type { TaxYtdIdentityKeyReader } from './tax-ytd.ts';
import type { FeeTaxCalculator, PayoutConfigPort } from './withdraw-rules.ts';

export type TaxMethod = 'none' | 'flat_rate' | 'cumulative';

/** One bracket of the progressive table: from from_fen (inclusive) on, rate_bp and the deduction. */
export interface TaxBracket {
  readonly from_fen: bigint;
  readonly rate_bp: bigint;
  readonly quick_deduction_fen: bigint;
}

/** The effective tax.SERVICE_FEE.* configuration (after the defaults). */
export interface TaxConfig {
  readonly method: TaxMethod;
  readonly rate_bp: bigint;
  readonly rate_table: readonly TaxBracket[];
}

export interface CumulativeTaxInput {
  /** tax_ytd.cum_income_fen of the current identity's row (0 without a row). */
  readonly ytdIncomeFen: bigint;
  /** tax_ytd.cum_withheld_fen of the current identity's row (0 without a row). */
  readonly ytdWithheldFen: bigint;
  /** Σ amount_fen of the in-flight withdrawals of the year. */
  readonly inFlightAmountFen: bigint;
  /** Σ tax_fen of the in-flight withdrawals of the year. */
  readonly inFlightTaxFen: bigint;
  /** This application's amount. */
  readonly amountFen: bigint;
  readonly table: readonly TaxBracket[];
}

export interface FeeTaxLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface FeeTaxCalculatorOptions {
  readonly config: PayoutConfigPort;
  readonly identityKey: TaxYtdIdentityKeyReader;
  readonly logger: FeeTaxLogger;
}

/** round_half_up(amountFen × ratioBp / denominator) for amountFen ≥ 0, in bigint. */
export function mulDivRoundHalfUp(amountFen: bigint, ratioBp: bigint, denominator: bigint): bigint {
  void amountFen;
  void ratioBp;
  void denominator;
  throw new Error('NotImplemented: mulDivRoundHalfUp');
}

/** flat_rate: round_half_up(amountFen × rateBp / 10000). */
export function flatRateTaxFen(amountFen: bigint, rateBp: bigint): bigint {
  void amountFen;
  void rateBp;
  throw new Error('NotImplemented: flatRateTaxFen');
}

/** 应扣(X): the bracket X falls in, round_half_up(X × rate_bp / 10000) − quick_deduction_fen. */
export function dueTaxFen(incomeFen: bigint, table: readonly TaxBracket[]): bigint {
  void incomeFen;
  void table;
  throw new Error('NotImplemented: dueTaxFen');
}

/** cumulative: max(0, due(ytd + in-flight + amount) − ytd withheld − in-flight tax). */
export function cumulativeTaxFen(input: CumulativeTaxInput): bigint {
  void input;
  throw new Error('NotImplemented: cumulativeTaxFen');
}

/** The tax_rule_version of an effective configuration. */
export function taxRuleVersion(config: TaxConfig): string {
  void config;
  throw new Error('NotImplemented: taxRuleVersion');
}

export function createFeeTaxCalculator(options: FeeTaxCalculatorOptions): FeeTaxCalculator {
  void options;
  throw new Error('NotImplemented: createFeeTaxCalculator');
}
