// The worker's fund metrics (B1-01zzi; 规划/02 §13; BR-FUND-02, BR-FUND-04, BR-CALC-13, BR-WDR-14).
// platform imports no business module: the shape is defined here and entry.ts assembles it from the
// orders, settlement and payout read ports, read at scrape time.

/** One scrape's fund values. */
export interface FundMetricsSnapshot {
  /** order_sync_pending rows in status open, per reason (a reason without open rows is absent). */
  readonly orderSyncPendingOpen: Readonly<Record<string, number>>;
  /** settle_jobs rows with job bill in status failed. */
  readonly billJobsFailed: number;
  /** settle_batches rows in status PARTIAL. */
  readonly partialBatches: number;
  /** Beneficiary shares still held whose first held event is at least 30 days before now. */
  readonly beneficiariesHeldOver30Days: number;
  /** withdrawals rows in status PAYING with needs_manual set. */
  readonly payingNeedsManual: number;
}
