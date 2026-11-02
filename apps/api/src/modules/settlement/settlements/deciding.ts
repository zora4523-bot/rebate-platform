// B2-04zp (D10-588 ⑤, BR-FUND-09): which settlement record decides the amount. Skeleton: the rule
// tests in test/spec/settlement/deciding-settlement/ are red on it until the implementation.

export interface DecidingSettlementRow {
  readonly seq: number;
  readonly source: 'API' | 'STATEMENT';
  /** When we obtained the record: the cut-off compares this, never the union's settlement time. */
  readonly createdAt: Date;
}

/**
 * The record that decides the amount among those obtained up to and including cutoffMs: the greatest
 * seq STATEMENT when there is one, otherwise the greatest seq API; null when no record qualifies.
 * Only the amount: the seq a batch item stores stays the order's greatest seq within the cut-off.
 */
export function decidingSettlement<T extends DecidingSettlementRow>(
  rows: readonly T[],
  cutoffMs: number,
): T | null {
  void rows;
  void cutoffMs;
  throw new Error('NotImplemented: decidingSettlement');
}
