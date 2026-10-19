import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';

export interface LedgerInvariantFile {
  readonly name: string;
  readonly sql: string;
}

/** Trusted SQL source. Omission selects db/invariants/ledger/*.sql. */
export interface LedgerInvariantSource {
  load(): Promise<readonly LedgerInvariantFile[]>;
}

/**
 * Compatible with pino; flat warning fields include accounting_date and invariant.
 * Differences also carry scope/app_id/account_id; empty checks use
 * event=ledger_daily_check_empty and checked_rows='0' (bigint-safe logging).
 */
export interface DailyCheckLogger {
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
}

export interface DailyCheckDependencies {
  readonly clock: Clock;
  readonly logger: DailyCheckLogger;
  readonly invariants?: LedgerInvariantSource;
}

export interface DailyCheckInput {
  /** Limits snapshot writes and reported differences; SQL checked_rows remains global. */
  readonly appId?: string;
  /** Explicit day being checked, not the trigger day (no second D−1 subtraction). */
  readonly accountingDate: string;
}

export interface LedgerDifference {
  readonly invariant: string;
  readonly scope: 'account' | 'global';
  readonly app_id: string;
  readonly account_id: string | null;
  readonly detail: unknown;
}

export interface DailyCheckResult {
  readonly accountingDate: string;
  /** Filename order; checkedRows counts the inspected population once, not per difference. */
  readonly checks: readonly {
    readonly file: string;
    readonly invariant: string;
    readonly checkedRows: bigint;
  }[];
  readonly accountDifferences: readonly LedgerDifference[];
  readonly globalDifferences: readonly LedgerDifference[];
  readonly emptyChecks: readonly string[];
  readonly recommendations: {
    readonly createDiscrepancies: boolean;
    readonly freezeWithdrawals: boolean;
    readonly disableAutoSettlement: boolean;
  };
}

export interface DailyCheckRunner {
  runDailyCheck(db: Kysely<DB>, input: DailyCheckInput): Promise<DailyCheckResult>;
}

// TODO(规划/11 §4.2): 冻结提现、关闭 settle.auto.enabled、生成差错单仅返回处置建议 — blocked on B2-04 / B2-05
// TODO(规划/11 §4.2): worker 每日 01:00 +08:00 调用运行器，传入 D−1 — blocked on worker 装配任务（本任务路径之外）
export function createDailyCheck(dependencies: DailyCheckDependencies): DailyCheckRunner {
  void dependencies;
  throw new Error('NotImplemented: createDailyCheck');
}
