import type { components } from '@couli/contracts-ts';
import type { RegisteredPlatform } from './types.ts';

export interface PddQuoteFactors {
  readonly selfBuyFactorBp: bigint;
  readonly accountLevelFactorBp: bigint;
}

/** Inputs already normalized by the adapter; amounts are fen and ratios are integer bp. */
export interface QuoteNInput {
  readonly platform: RegisteredPlatform;
  readonly finalPriceFen: bigint;
  readonly commissionRateBp: bigint;
  readonly orderType: components['schemas']['OrderScope'];
  readonly techFeeBp: bigint;
  /** Required for PDD at runtime (no defaults); ignored for Taobao and JD. */
  readonly pdd?: PddQuoteFactors;
}

/** BR-CALC-17 / BR-CALC-20: pre-order N_quote, before reserve and commission splitting. */
export function quoteN(input: QuoteNInput): bigint {
  void input;
  throw new Error('NotImplemented: quoteN');
}
