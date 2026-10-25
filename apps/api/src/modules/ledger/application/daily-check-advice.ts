// Disposal advice of the daily check (BR-FUND-19; B2-02o, BR-PAY-07, D10-358 ②, D10-359):
// differences of pay- invariant files (collections, db/invariants/ledger/pay-*.sql), global ones
// included, still ask for a discrepancy but never for a withdrawal hold or for disabling automatic
// settlement; every other invariant keeps its advice.

/** One reported difference and the invariant file it came from (after the appId filter). */
export interface DailyCheckFinding {
  readonly file: string;
  readonly scope: 'account' | 'global';
}

export interface DailyCheckRecommendations {
  readonly createDiscrepancies: boolean;
  readonly freezeWithdrawals: boolean;
  readonly disableAutoSettlement: boolean;
}

/** The runner's recommendations for the differences it reports. */
export function recommendDailyCheckActions(
  findings: readonly DailyCheckFinding[],
): DailyCheckRecommendations {
  void findings;
  throw new Error('NotImplemented: recommendDailyCheckActions');
}
