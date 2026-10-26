// B2-11a: BR-WDR-29 审核风险标签快照 at BR-WDR-03 ⑭ (task 9.3). W1 (withdraw-apply.ts) calls
// compute() inside its transaction after the first pass and before the locks, with t = that
// application's Clock now and the id the insert will use; the result goes into the withdrawal row
// (risk_flags, risk_flags_at = t) and is never recomputed. A refused first pass computes nothing.
// - ①②④⑤⑥⑦⑧⑩ from WithdrawRiskFactsReader (default: ../infra/withdraw-risk-facts.ts); ③ only
//   through risk's SameDeviceAccountsCheck (BR-ID-37) with ref {type: 'withdrawal', id}.
// - Each item runs in its own savepoint: a failed (or timed out) read rolls back to it, the item
//   gives no label, and one trailing {code: 'risk_calc_failed', value: [failed codes], threshold:
//   null} is added; the application is never refused for it. Labels in BR order, hits only, [] when
//   none.
// - Thresholds risk.withdraw.* through the configuration port; missing, malformed or unreadable →
//   the defaults 3000 / 3 / 5000 / 5000 / 5 / 10000.
// Rule tests: test/spec/payout/risk-flags/**.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Logger } from 'pino';
import type { SameDeviceAccountsCheck } from '../../risk/index.ts';
import type { SelfOrderFact, WithdrawRiskFlag } from '../domain/risk-flags.ts';
import type { PayoutConfigPort } from './withdraw-rules.ts';

/** The application being judged, at t. */
export interface WithdrawRiskSubject {
  readonly appId: string;
  readonly userId: string;
  /** The id the W1 insert uses (③'s ref). */
  readonly withdrawalId: string;
  /** This application's amount, counted in ⑥'s numerator. */
  readonly amountFen: bigint;
  /** The payee HMAC of the member's current payout account (⑩). */
  readonly payeeHmac: string;
  /** t. Windows are [t − N×24 h, t], both ends closed; ② is t's +08:00 day from 00:00 to t. */
  readonly now: Date;
}

/** The facts behind ①②④⑤⑥⑦⑧⑩, read on the handle given (the W1 transaction). */
export interface WithdrawRiskFactsReader {
  /** ① a withdrawal of the member with status PAID_API or PAID_MANUAL exists. */
  hasPaidWithdrawal(handle: Kysely<DB>, subject: WithdrawRiskSubject): Promise<boolean>;
  /** ② a REBATE_CREDIT / SHARE_CREDIT / REFERRAL_CREDIT entry of the member in t's day up to t. */
  creditedToday(handle: Kysely<DB>, subject: WithdrawRiskSubject): Promise<boolean>;
  /**
   * ④⑤ the member's attributed buy_type=self sub-orders with paid_at in the 60-day window, one
   * fact per sub-order however many order_rights rows it has; est_commission_fen and
   * commission_base_fen are the union's synced values (orders.est_commission_fen, pay_amount_fen).
   */
  selfOrders60d(
    handle: Kysely<DB>,
    subject: WithdrawRiskSubject,
  ): Promise<readonly SelfOrderFact[]>;
  /**
   * ⑥ amount_fen of the member's withdrawals created in the 30-day window with status not in
   * {REJECTED, FAILED}; this application is not among them (compute() adds amountFen).
   */
  withdrawn30dFen(handle: Kysely<DB>, subject: WithdrawRiskSubject): Promise<bigint>;
  /**
   * ⑥ the member's rebate shares as beneficiary (self, share, direct) on sub-orders with received_at
   * in the 60-day window and rebate_status WAITING (current estimate) or CREDITED (net credited).
   */
  received60dFen(handle: Kysely<DB>, subject: WithdrawRiskSubject): Promise<bigint>;
  /** ⑦ an entry of the member with balance_after_fen < 0 exists. */
  hadNegative(handle: Kysely<DB>, subject: WithdrawRiskSubject): Promise<boolean>;
  /** ⑧ a withdraw_holds row of the member with reason recon_diff exists (released ones included). */
  reconDiff(handle: Kysely<DB>, subject: WithdrawRiskSubject): Promise<boolean>;
  /**
   * ⑩ (BR-WDR-02 细则) another member's binding of the payee HMAC was still held at some instant of
   * the 90 × 24 hours up to the binding time of the member's current payout account (both ends
   * closed; whenever it ended). The anchor is that binding time, not t: every later withdrawal of
   * the member carries the label.
   */
  payeePrevOtherUser(handle: Kysely<DB>, subject: WithdrawRiskSubject): Promise<boolean>;
}

export interface WithdrawRiskFlagsOptions {
  /** risk.withdraw.* thresholds, read on the W1 transaction. */
  readonly config: PayoutConfigPort;
  readonly logger: Pick<Logger, 'warn'>;
  /** ③ BR-ID-37, judged in the caller's transaction (B1-03k / B1-03n). */
  readonly sameDevice: SameDeviceAccountsCheck;
  /** Absent: createWithdrawRiskFactsReader(). */
  readonly facts?: WithdrawRiskFactsReader;
}

export interface WithdrawRiskFlags {
  compute(trx: Transaction<DB>, subject: WithdrawRiskSubject): Promise<readonly WithdrawRiskFlag[]>;
}

/** What W1 (createWithdrawApply's options) takes to write the snapshot. */
export interface WithdrawApplyRiskOptions {
  riskFlags?: WithdrawRiskFlags;
}

export function createWithdrawRiskFlags(options: WithdrawRiskFlagsOptions): WithdrawRiskFlags {
  void options;
  throw new Error('NotImplemented: createWithdrawRiskFlags');
}
