import type { components } from '@couli/contracts-ts';
import { InvalidRatio, mulBpBpFloor, mulDivFloor, subFen } from '@couli/money';
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

const BP = 10000n;

/** Missing or malformed PDD configuration is a ratio error; never fall back to a default. */
function requirePddFactors(pdd: unknown): PddQuoteFactors {
  if (typeof pdd !== 'object' || pdd === null) {
    throw new InvalidRatio('PDD quote requires selfBuyFactorBp and accountLevelFactorBp');
  }
  const { selfBuyFactorBp, accountLevelFactorBp } = pdd as Record<string, unknown>;
  for (const factor of [selfBuyFactorBp, accountLevelFactorBp]) {
    if (typeof factor !== 'bigint' || factor < 0n || factor > BP) {
      throw new InvalidRatio('PDD factor must be bigint basis points in 0..10000');
    }
  }
  return {
    selfBuyFactorBp: selfBuyFactorBp as bigint,
    accountLevelFactorBp: accountLevelFactorBp as bigint,
  };
}

/**
 * BR-CALC-17 / BR-CALC-20: pre-order N_quote, before reserve and commission splitting.
 * gross = floor(final × rate / 10000); fee = floor(gross × tech_fee / 10000); N = gross − fee.
 * PDD then converts N (the share-basis commission, after tech fee): self floors once over
 * both factors (mulBpBpFloor), share applies the account-level factor only. Taobao and JD
 * return N for both order types. All checks go through @couli/money (InvalidAmount / InvalidRatio).
 */
export function quoteN(input: QuoteNInput): bigint {
  const { platform, orderType } = input;
  const gross = mulDivFloor(input.finalPriceFen, input.commissionRateBp, BP);
  const fee = mulDivFloor(gross, input.techFeeBp, BP);
  const net = subFen(gross, fee, { nonNegative: true });
  if (orderType !== 'self' && orderType !== 'share') {
    throw new TypeError(`Unknown order type: ${String(orderType)}`);
  }
  switch (platform) {
    case 'taobao':
    case 'jd':
      return net;
    case 'pdd': {
      const { selfBuyFactorBp, accountLevelFactorBp } = requirePddFactors(input.pdd);
      return orderType === 'self'
        ? mulBpBpFloor(net, selfBuyFactorBp, accountLevelFactorBp)
        : mulDivFloor(net, accountLevelFactorBp, BP);
    }
    default:
      throw new TypeError(`Unknown platform: ${String(platform as unknown)}`);
  }
}
