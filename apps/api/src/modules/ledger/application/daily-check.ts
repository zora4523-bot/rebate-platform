// Daily ledger check (BR-FUND-19; ledger-plan D9 A, D18 A; decisions 20, 31, 33, 34): for the
// accounting date D it is given, writes daily_balances from the entries, then runs every
// invariant file in its own read-only transaction and reports the differences.
import type { DB } from '@couli/db';
import { chinaDayRange } from '@couli/domain';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import { runInvariantQuery, writeDailyBalances } from '../infra/daily-check-store.ts';
import { directoryInvariantSource } from '../infra/invariant-files.ts';
import {
  assertSingleStatement,
  orderInvariantFiles,
  readInvariantRows,
} from './daily-check-rows.ts';
import type { LedgerDifference, LedgerInvariantSource } from './daily-check-types.ts';
import { LedgerError } from './errors.ts';

export type {
  LedgerDifference,
  LedgerInvariantFile,
  LedgerInvariantSource,
} from './daily-check-types.ts';

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
  const { clock, logger } = dependencies;
  const source = dependencies.invariants ?? directoryInvariantSource();
  return {
    async runDailyCheck(db, input) {
      const { accountingDate, appId } = validateInput(input);
      const base = { event: 'ledger_daily_check_failed', accounting_date: accountingDate };
      // Load and vet the SQL first: a broken file set stops the run before anything is written.
      const files = orderInvariantFiles(await source.load());
      for (const file of files) assertSingleStatement(file);

      try {
        await writeDailyBalances(db, { accountingDate, appId, computedAt: clock.now() });
      } catch (error) {
        logger.error({ ...base, step: 'daily_balances', sqlstate: sqlState(error) });
        throw new LedgerError('DAILY_CHECK_FAILED', `daily_balances of ${accountingDate}`, {
          cause: error,
        });
      }

      const checks: { file: string; invariant: string; checkedRows: bigint }[] = [];
      const accountDifferences: LedgerDifference[] = [];
      const globalDifferences: LedgerDifference[] = [];
      const emptyChecks: string[] = [];
      for (const file of files) {
        let rows: unknown;
        try {
          rows = await runInvariantQuery(db, file.sql, accountingDate);
        } catch (error) {
          logger.error({ ...base, step: 'invariant', file: file.name, sqlstate: sqlState(error) });
          throw new LedgerError('DAILY_CHECK_FAILED', `invariant file ${file.name}`, {
            cause: error,
          });
        }
        const outcome = readInvariantRows(file.name, rows);
        checks.push({
          file: file.name,
          invariant: outcome.invariant,
          checkedRows: outcome.checkedRows,
        });
        // D18: nothing inspected is a warning of its own, never a global difference.
        if (outcome.checkedRows === 0n) {
          emptyChecks.push(outcome.invariant);
          logger.warn(
            {
              event: 'ledger_daily_check_empty',
              accounting_date: accountingDate,
              file: file.name,
              invariant: outcome.invariant,
              checked_rows: '0',
            },
            'ledger daily check inspected no rows',
          );
        }
        // appId limits what is reported; checked_rows stays the SQL's (global) count.
        for (const difference of outcome.differences) {
          if (appId !== undefined && difference.app_id !== appId) continue;
          (difference.scope === 'account' ? accountDifferences : globalDifferences).push(
            difference,
          );
          // Flat fields only; detail stays in the result (it may name beneficiaries).
          logger.warn(
            {
              event: 'ledger_daily_check_difference',
              accounting_date: accountingDate,
              file: file.name,
              invariant: difference.invariant,
              scope: difference.scope,
              app_id: difference.app_id,
              account_id: difference.account_id,
            },
            'ledger daily check difference',
          );
        }
      }

      const anyDifference = accountDifferences.length > 0 || globalDifferences.length > 0;
      return {
        accountingDate,
        checks,
        accountDifferences,
        globalDifferences,
        emptyChecks,
        // Account-level (①⑥⑦⑧): discrepancy + withdraw hold. Global (②③④⑤): also switch
        // settle.auto.enabled off and hold every involved user. Only advice here (TODO above).
        recommendations: {
          createDiscrepancies: anyDifference,
          freezeWithdrawals: anyDifference,
          disableAutoSettlement: globalDifferences.length > 0,
        },
      };
    },
  };
}

function validateInput(input: DailyCheckInput): {
  accountingDate: string;
  appId: string | undefined;
} {
  const { accountingDate, appId } = input;
  try {
    // Strict YYYY-MM-DD of an existing calendar day (@couli/domain).
    chinaDayRange(accountingDate);
  } catch (error) {
    throw new LedgerError('INVALID_INPUT', 'accountingDate must be an existing YYYY-MM-DD', {
      cause: error,
    });
  }
  if (appId !== undefined && (typeof appId !== 'string' || appId === '')) {
    throw new LedgerError('INVALID_INPUT', 'appId must be a non-empty string');
  }
  return { accountingDate, appId };
}

/** The SQLSTATE of a PostgreSQL error (for the log line); undefined for anything else. */
function sqlState(error: unknown): string | undefined {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}
