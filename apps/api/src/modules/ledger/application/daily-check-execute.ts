// B2-02p: the execution step of the daily ledger check (BR-FUND-19 R3; BR-WDR-05). It takes the
// differences of one run (each with the invariant file it came from) and acts on them, per app:
// - every difference is registered as a ledger_mismatch recon diff (source R3, period = the
//   checked accounting day D) through registerReconDiffOnce; ref_type ledger_account (account
//   level), voucher (②) or order (③④⑤⑧⑨, order_key); ref_id `<invariant>:<entity id>`;
//   dedupe_key `R3:<D>:<invariant>:<entity id>`; expected / actual / diff from the detail's paired
//   amounts (diff = expected − actual), else 0 / 0 / 0; the detail kept in resolution;
// - for a non pay- difference, in the same transaction and only when that call inserted the diff,
//   one withdraw_holds row per involved user through the injected payout port (reason
//   ledger_mismatch, source_ref `recon_diff:<id>`, created_by system); a difference whose users
//   cannot be resolved is registered and logged, never held on a guess;
// - an app with any non pay- global difference gets settle.auto.enabled switched off once through
//   the injected content port, and the alert is raised only after the commit.
// pay- differences (collections, D10-358 ②) are only registered. Ports are declared here and
// injected by the assembly (ledger never imports payout or content; B2-09b precedent).
import type { DB } from '@couli/db';
import type { Kysely, Transaction } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import type { DailyCheckLogger } from './daily-check.ts';
import type { LedgerDifference } from './daily-check-types.ts';

/** One withdrawal hold of a ledger mismatch (same shape as payout's AddWithdrawHold). */
export interface LedgerMismatchHoldInput {
  readonly appId: string;
  readonly userId: string;
  readonly reason: 'ledger_mismatch';
  /** Exactly `recon_diff:<recon_diffs.id>` (released by the close of that diff, B2-09b). */
  readonly sourceRef: string;
  readonly createdBy: 'system';
  readonly holdUntil: null;
}

/** The payout port: adds one withdraw_holds row on the caller's transaction. */
export interface LedgerMismatchHolds {
  add(trx: Transaction<DB>, input: LedgerMismatchHoldInput): Promise<{ readonly id: string }>;
}

/** Same shape as content's SystemSwitchInput (F1-02zk). */
export interface AutoSettlementSwitchInput {
  readonly appId: string;
  readonly key: 'settle.auto.enabled';
  readonly source: string;
  readonly reason: string;
}

/** Same shape as content's SystemSwitchResult (F1-02zk). */
export interface AutoSettlementSwitchResult {
  readonly key: 'settle.auto.enabled';
  readonly changed: boolean;
  readonly version: number;
  readonly fromValue: unknown;
}

/** The content port (shape of SystemSwitchWriter): switch off in a transaction, alert after it. */
export interface AutoSettlementSwitch {
  turnOff(
    trx: Transaction<DB>,
    input: AutoSettlementSwitchInput,
  ): Promise<AutoSettlementSwitchResult>;
  /** Called only after the transaction of turnOff committed. */
  alertCommitted(input: AutoSettlementSwitchInput, result: AutoSettlementSwitchResult): void;
}

export interface DailyCheckExecuteDependencies {
  readonly clock: Clock;
  readonly logger: DailyCheckLogger;
  readonly holds: LedgerMismatchHolds;
  readonly autoSettlement: AutoSettlementSwitch;
}

/** One reported difference and the invariant file (basename) it came from. */
export interface DailyCheckFiledDifference extends LedgerDifference {
  readonly file: string;
}

export interface DailyCheckExecutionInput {
  /** The checked accounting day D (YYYY-MM-DD), the period of every diff. */
  readonly accountingDate: string;
  readonly differences: readonly DailyCheckFiledDifference[];
}

/** One registered recon diff of the run. */
export interface DailyCheckExecutedDiff {
  readonly appId: string;
  readonly reconDiffId: string;
  readonly invariant: string;
  readonly refType: string;
  readonly refId: string;
  /** true only when this run inserted the diff (a rerun of the same day sees false). */
  readonly inserted: boolean;
  /** Users a hold was added for by this run (empty on a rerun, for pay- and unresolved). */
  readonly heldUserIds: readonly string[];
}

export interface DailyCheckExecution {
  readonly accountingDate: string;
  readonly reconDiffs: readonly DailyCheckExecutedDiff[];
  /** Apps whose settle.auto.enabled was switched off by this run (turnOff called). */
  readonly autoSettlementOff: readonly string[];
}

export interface DailyCheckExecutor {
  execute(db: Kysely<DB>, input: DailyCheckExecutionInput): Promise<DailyCheckExecution>;
}

export function createDailyCheckExecutor(
  dependencies: DailyCheckExecuteDependencies,
): DailyCheckExecutor {
  void dependencies;
  throw new Error('NotImplemented: createDailyCheckExecutor');
}
