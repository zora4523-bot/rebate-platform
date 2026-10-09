import { sql } from 'kysely';
import type { DB } from '@couli/db';
import type { Kysely, RawBuilder } from 'kysely';
import { AdmissionUnavailableError } from '../admission/index.ts';
import type { CrashPoint, PgRunDeps, TxStep } from './types.ts';

/** Crash hooks model process death, and must bypass storage retry/translation. */
class ProcessCrash {
  readonly thrown: unknown;
  constructor(thrown: unknown) {
    this.thrown = thrown;
  }
}

export class TransactionFailure extends Error {
  readonly original: unknown;
  readonly commitAttempted: boolean;
  constructor(original: unknown, commitAttempted: boolean) {
    super('Agent transaction failed');
    this.original = original;
    this.commitAttempted = commitAttempted;
  }
}

export interface Queries {
  query<T>(statement: RawBuilder<T>): Promise<T[]>;
}

export function errorCode(error: unknown): string | undefined {
  if (error instanceof TransactionFailure) return errorCode(error.original);
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return undefined;
}

export function retryable(error: unknown): boolean {
  if (error instanceof AdmissionUnavailableError) return true;
  if (!(error instanceof TransactionFailure)) return false;
  const code = errorCode(error);
  return (
    code === undefined ||
    code.startsWith('08') ||
    code.startsWith('53') ||
    [
      '40001',
      '40P01',
      '55P03',
      '57014',
      '57P01',
      '57P02',
      '57P03',
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
    ].includes(code)
  );
}

export function unavailable(error: unknown): never {
  // Outcome lookup has already classified these errors. In particular, a failed lookup
  // cannot turn an unknown admission outcome into a confirmed rollback at the port boundary.
  if (error instanceof AdmissionUnavailableError) throw error;
  if (error instanceof TransactionFailure && error.original instanceof AdmissionUnavailableError)
    throw error.original;
  if (retryable(error)) {
    throw new AdmissionUnavailableError(
      error instanceof TransactionFailure && error.commitAttempted ? 'unknown' : 'rolled_back',
    );
  }
  if (error instanceof TransactionFailure) throw error.original;
  throw error;
}

/** Only public port boundaries unwrap a crash; inner catches cannot mistake it for a PG fault. */
export async function port<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ProcessCrash) throw error.thrown;
    return unavailable(error);
  }
}

export function createTransactions(deps: PgRunDeps) {
  function crash(step: TxStep, phase: 'before' | 'after'): void {
    if (['lookup', 'hold', 'cancel_poll'].includes(step)) return;
    try {
      deps.hooks?.crash?.(step as CrashPoint, phase);
    } catch (error) {
      throw new ProcessCrash(error);
    }
  }

  return async function transaction<T>(
    step: TxStep,
    work: (q: Queries) => Promise<T>,
    prepare?: (q: Queries) => Promise<void>,
  ): Promise<T> {
    crash(step, 'before');
    let commitAttempted = false;
    let result: T;
    try {
      result = await deps.db.connection().execute(async (connection: Kysely<DB>) => {
        try {
          // Connection metadata bootstrap, before starting the instrumented transaction. Every
          // statement in the transaction (including the first SET) runs through beforeSql.
          const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(
            connection,
          );
          const pid = rows[0]!.pid;
          if (prepare) {
            await prepare({
              async query(statement) {
                await deps.hooks?.beforeSql?.(step, pid);
                return (await statement.execute(connection)).rows;
              },
            });
          }
          await deps.hooks?.beforeSql?.(step, pid);
          return await connection
            .transaction()
            .setIsolationLevel('read committed')
            .execute(async (trx) => {
              const q: Queries = {
                async query(statement) {
                  await deps.hooks?.beforeSql?.(step, pid);
                  return (await statement.execute(trx)).rows;
                },
              };
              await q.query(sql`SET LOCAL lock_timeout = '2s'`);
              await q.query(sql`SET LOCAL statement_timeout = '3s'`);
              const value = await work(q);
              await deps.hooks?.beforeCommit?.(step, pid);
              await deps.hooks?.beforeSql?.(step, pid);
              commitAttempted = true;
              return value;
            });
        } catch (error) {
          // Kysely skips ROLLBACK when BEGIN fails. A pg FATAL response can reject BEGIN
          // before the socket closes, while pg still considers the client reusable. Keep
          // this lease until another round trip either confirms a clean session or observes
          // the disconnect: pg then marks it non-queryable and pg-pool discards it on release.
          // Cleanup must also cover bootstrap/preparation failures and must not use fault
          // hooks (a hook failure must never prevent rollback). Never terminate another PID
          // or destroy the shared pool. Preserve the original failure and commit phase.
          try {
            await sql`ROLLBACK`.execute(connection);
          } catch {
            // The failed cleanup has observed the broken connection before it is released.
          }
          throw error;
        }
      });
      await deps.hooks?.afterCommit?.(step);
    } catch (error) {
      throw new TransactionFailure(error, commitAttempted);
    }
    crash(step, 'after');
    return result;
  };
}

export type Transactions = ReturnType<typeof createTransactions>;
