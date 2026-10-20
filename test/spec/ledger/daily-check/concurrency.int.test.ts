import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type DatabaseConnection, type QueryResult } from 'kysely';
import { expect, it, vi } from 'vitest';

import { APP, DAY, TIMEOUT, account, pair, platform, setup, snapshots, voucher } from './kit.ts';

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

it(
  '[AC-B2-02m#5] 全品牌写入前暂停时单品牌重跑等待锁：两次成功，最终日余额包含迟到分录',
  async () => {
    const database = await createTestDatabase();
    // Independent pools: a paused transaction must not prevent fixtures or B from connecting.
    const options = { connectionString: database.urlFor('couli_app'), max: 1 };
    const db = createDb(options);
    const runA = createDb(options);
    const runB = createDb(options);
    const beforeWrite = signal();
    const releaseA = signal();
    const running: Promise<unknown>[] = [];
    let paused = false;

    try {
      // Bound database waits too, including failure-path cleanup; no lock-name dependency.
      for (const connection of [db, runA, runB]) {
        await sql`SET statement_timeout = '12s'`.execute(connection);
      }
      const a = await account(db, { app_id: APP });
      const p = await platform(db, 'UNION_RECEIVABLE:taobao', APP);
      await db.transaction().execute(async (trx) => {
        await pair(trx, a, p, await voucher(trx, { app_id: APP }), -100n);
      });
      const pidA = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(runA))
        .rows[0]!.pid;
      const pidB = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(runB))
        .rows[0]!.pid;
      expect(pidA).not.toBe(pidB);
      const { runner } = setup();
      const resultA = runA
        .connection()
        .execute(async (pinnedDb) => {
          const connection = await pinnedDb.getExecutor().provideConnection(async (value) => value);
          const execute = connection.executeQuery.bind(connection);
          const spy = vi
            .spyOn(connection, 'executeQuery')
            .mockImplementation(
              async <R>(
                ...args: Parameters<DatabaseConnection['executeQuery']>
              ): Promise<QueryResult<R>> => {
                // Pause BEFORE sending the write, including atomic INSERT ... SELECT.
                // Match the public table only, without depending on the mutex's lock key.
                const writesDailyBalances =
                  /\b(?:insert\s+into|update)\s+(?:"?app"?\s*\.\s*)?"?daily_balances"?\b/i.test(
                    args[0].sql,
                  );
                if (!paused && writesDailyBalances) {
                  paused = true;
                  beforeWrite.resolve();
                  await bounded(releaseA.promise, 'release A before writing daily_balances');
                }
                return execute<R>(...args);
              },
            );
          try {
            return await runner.runDailyCheck(pinnedDb, { accountingDate: DAY });
          } finally {
            spy.mockRestore();
          }
        })
        .then(
          (value) => ({ status: 'fulfilled', value }) as const,
          (error: unknown) => ({ status: 'rejected', error }) as const,
        );
      running.push(resultA);
      await bounded(beforeWrite.promise, 'A must reach the daily_balances write');
      expect(paused).toBe(true);

      // A has not sent its INSERT ... SELECT, so no snapshot row lock can mask a missing mutex.
      await db.transaction().execute(async (trx) => {
        const late = await voucher(trx, { app_id: APP, accounting_date: DAY });
        await pair(trx, a, p, late, -50n, { account_version: 2n });
        await pair(trx, a, p, late, 20n, { ledger_type: 'CLAWBACK', account_version: 3n });
      });

      let bFinished = false;
      const resultB = runner
        .runDailyCheck(runB, { accountingDate: DAY, appId: APP })
        .then(
          (value) => ({ status: 'fulfilled', value }) as const,
          (error: unknown) => ({ status: 'rejected', error }) as const,
        )
        .finally(() => {
          bFinished = true;
        });
      running.push(resultB);

      // B must wait for A's lock while A has not sent its write. Finishing early is a failure,
      // even if both runs would eventually produce the same totals without the mutex.
      let blockedByA = false;
      await expect
        .poll(
          async () => {
            if (bFinished) return true;
            const waiting = await sql<{ blocked: boolean }>`
              SELECT wait_event_type = 'Lock'
                AND ${pidA}::integer = ANY(pg_blocking_pids(pid)) AS blocked
              FROM pg_stat_activity
              WHERE pid = ${pidB}::integer
            `.execute(db);
            blockedByA = waiting.rows[0]?.blocked === true;
            return blockedByA || bFinished;
          },
          { timeout: 10_000, interval: 20 },
        )
        .toBe(true);
      expect(bFinished, 'B must not finish while A is paused before its write').toBe(false);
      expect(blockedByA, 'B must observably wait for a lock held by A').toBe(true);
      releaseA.resolve();

      const outcomes = await bounded(Promise.all([resultA, resultB]), 'both daily checks finish');
      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({ status: 'fulfilled', value: { accountingDate: DAY } });
      }
      const rows = (await snapshots(db)).filter((row) => row.day === DAY);
      expect(rows).toHaveLength(2);
      // All entries, hand-calculated: user credits 100 + 50, debit 20, closing -130.
      // The platform is the exact counter-entry: debit 150, credit 20, closing +130.
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            app_id: APP,
            account_id: a.id,
            sub_account: 'available',
            opening_fen: 0n,
            debit_fen: 20n,
            credit_fen: 150n,
            closing_fen: -130n,
          }),
          expect.objectContaining({
            app_id: APP,
            account_id: p.id,
            sub_account: 'available',
            opening_fen: 0n,
            debit_fen: 150n,
            credit_fen: 20n,
            closing_fen: 130n,
          }),
        ]),
      );
    } finally {
      releaseA.resolve();
      await Promise.allSettled(running);
      await Promise.all([destroyDb(db), destroyDb(runA), destroyDb(runB)]);
      await database.drop();
    }
  },
  TIMEOUT,
);
