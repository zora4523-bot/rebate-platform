// B2-11a: the facts behind BR-WDR-29 ①②④⑤⑥⑦⑧⑩ as a port (the default reader is
// ../infra/withdraw-risk-facts.ts; createWithdrawRiskFlags in ./withdraw-risk-flags.ts consumes it).
// Rule tests: test/spec/payout/risk-flags/**.
//
// Also compiled by the `test` project: erasable syntax only, `import type` for type-only imports,
// relative imports with `.ts`.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { SelfOrderFact } from '../domain/risk-flags.ts';

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
