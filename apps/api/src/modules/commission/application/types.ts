import type { components } from '@couli/contracts-ts';
import type {
  CardQuoteContext,
  CardRebateQuoter,
  RebateQuote,
  Viewer,
} from '../../catalog/index.ts';
import type { UnionItem } from '../../union/index.ts';

/** Type-only in the test-stage skeleton (no const declarations allowed by task §3).
 * The implementation exports the runtime list with this same name and tuple type.
 */
export type COMMISSION_QUOTE_CONFIG_KEYS = readonly [
  'commission.platforms',
  'tech_fee_bp',
  'rebate.taobao.compare_rate_ratio_bp',
  'union.pdd.self_buy_factor_bp',
  'union.pdd.account_level_factor_bp',
];

/** Cards supply self; the commission port also accepts callers' share quotes. */
export interface CommissionQuoteContext extends Omit<CardQuoteContext, 'buyType'> {
  readonly buyType: components['schemas']['OrderScope'];
}

export interface CommissionRebateQuoter extends CardRebateQuoter {
  quote(item: UnionItem, viewer: Viewer, context?: CommissionQuoteContext): Promise<RebateQuote>;
  /** Replaces the previous prepared scope. Subsequent quotes use only these pre-read values. */
  prepare(appId: string, userIds: readonly string[]): Promise<void>;
}
