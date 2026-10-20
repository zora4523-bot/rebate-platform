import type { DB } from '@couli/db';
import type { Transaction } from 'kysely';

export interface OrderNetSelection {
  readonly appId: string;
  readonly orderKey: string;
}

export interface BeneficiaryOrderNet {
  readonly beneficiary_user_id: string;
  readonly role: 'self' | 'share' | 'direct' | 'indirect';
  readonly net_fen: bigint;
}

export interface OrderNets {
  /** BR-FUND-08 / 19④: complete beneficiary keys, including zero nets; unordered. */
  readonly beneficiaries: readonly BeneficiaryOrderNet[];
  /** Credit net of COMMISSION_REVENUE across all vouchers for this order. */
  readonly platform_net_fen: bigint;
  /** Debit net of UNION_RECEIVABLE for the order voucher kinds in BR-FUND-19⑤. */
  readonly union_receivable_net_fen: bigint;
}

/**
 * Read only, using the caller's transaction and (app_id, order_key).
 * Only ledger tables and structured voucher metadata determine attribution.
 * No order/user lookup, key parsing, clock cutoff, new transaction or balance lock.
 * Empty history returns an empty beneficiary list and bigint zero totals.
 */
export async function getOrderNets(
  trx: Transaction<DB>,
  input: OrderNetSelection,
): Promise<OrderNets> {
  void trx;
  void input;
  throw new Error('NotImplemented: getOrderNets');
}
