// Types shared by the daily-check runner, its row reader and its default SQL source (kept apart
// so those modules do not import one another in a cycle).

export interface LedgerInvariantFile {
  readonly name: string;
  readonly sql: string;
}

/** Trusted SQL source. Omission selects db/invariants/ledger/*.sql. */
export interface LedgerInvariantSource {
  load(): Promise<readonly LedgerInvariantFile[]>;
}

export interface LedgerDifference {
  readonly invariant: string;
  readonly scope: 'account' | 'global';
  readonly app_id: string;
  readonly account_id: string | null;
  readonly detail: unknown;
}
