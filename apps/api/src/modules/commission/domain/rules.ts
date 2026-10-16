import type { components, UserLevel } from '@couli/contracts-ts';

export interface RuleRow {
  readonly platform: components['schemas']['PlatformCode'];
  readonly level: UserLevel;
  readonly order_type: components['schemas']['OrderScope'];
  readonly r_own_bp: number;
  readonly r_direct_bp: number;
  readonly r_indirect_bp: number;
}

export interface RuleReserve {
  readonly platform: components['schemas']['PlatformCode'];
  readonly reserve_bp: number;
}

/** Only published, unrevoked versions cross the reader boundary; no time filtering there. */
export interface RuleVersion {
  readonly rule_version_id: string;
  readonly effective_from: Date;
  readonly indirect_enabled: boolean;
  readonly rules: readonly RuleRow[];
  readonly reserves: readonly RuleReserve[];
}

export interface RuleSetReader {
  publishedVersions(appId: string): Promise<readonly RuleVersion[]>;
}

/** BR-CALC-11 / task §9: quote time, inclusive seconds; no eligible version fails closed. */
export function selectRuleVersion(versions: readonly RuleVersion[], at: Date): RuleVersion {
  void versions;
  void at;
  throw new Error('NotImplemented: selectRuleVersion');
}

export interface QuoteTermsInput {
  readonly version: RuleVersion;
  readonly platforms: readonly components['schemas']['PlatformCode'][];
  readonly platform: components['schemas']['PlatformCode'];
  readonly level: UserLevel;
  readonly orderType: components['schemas']['OrderScope'];
}

/** Validate the selected version's full configured matrix, never borrow another row/version. */
export function selectQuoteTerms(input: QuoteTermsInput): {
  readonly reserve_bp: bigint;
  readonly r_own_bp: bigint;
} {
  void input;
  throw new Error('NotImplemented: selectQuoteTerms');
}
