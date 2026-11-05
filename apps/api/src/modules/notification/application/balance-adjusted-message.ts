// B2-12c skeleton (rule-test phase, implementation pending): the in-app message BALANCE_ADJUSTED of a
// manual balance adjustment (08 BR-FUND-24 ⑦, BR-TEXT-19 站内信 BALANCE_ADJUSTED: only on a decrease,
// inbox only, category service; 「你的余额调减 {amount}，原因：{adjust_reason}。如有疑问，请联系客服。」,
// {amount} per BR-TEXT-10 with ¥, {adjust_reason} the reason code's name of BR-TEXT-19; never the
// internal note, the operator or a document number). null for a form that sends nothing.
export type BalanceAdjustedDirection = 'increase' | 'decrease';

/** The executed form as the adjustment flow hands it over. */
export interface BalanceAdjustedFacts {
  readonly direction: BalanceAdjustedDirection;
  /** The form's amount, integer fen above 0. */
  readonly amount_fen: bigint;
  /** The form's reason code (the ADMIN_ADJUST sub_type). */
  readonly reason_code: string;
}

/** notify_templates title_override / body_override of the app, code and variant. */
export interface BalanceAdjustedOverride {
  readonly title_override: string | null;
  readonly body_override: string | null;
}

export interface BalanceAdjustedMessage {
  readonly code: 'BALANCE_ADJUSTED';
  readonly variant: 'default';
  readonly category: 'service';
  readonly title: string;
  readonly body: string;
}

export function renderBalanceAdjustedMessage(
  facts: BalanceAdjustedFacts,
  override: BalanceAdjustedOverride | null,
): BalanceAdjustedMessage | null {
  void facts;
  void override;
  throw new Error('NotImplemented: renderBalanceAdjustedMessage');
}
