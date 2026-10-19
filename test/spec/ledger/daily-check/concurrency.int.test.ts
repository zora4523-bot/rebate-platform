import { createDb, destroyDb } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql, type KyselyPlugin, type QueryId } from 'kysely';
import { expect, it } from 'vitest';

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
  '[AC-B2-02m#5] 全品牌旧读数与单品牌重跑交错：两次成功，最终日余额包含迟到分录',
  async () => {
    const database = await createTestDatabase();
    // Independent pools: a paused transaction must not prevent fixtures or B from connecting.
    const options = { connectionString: database.urlFor('couli_app'), max: 1 };
    const db = createDb(options);
    const runA = createDb(options);
    const runB = createDb(options);
    const readCompleted = signal();
    const releaseA = signal();
    const running: Promise<unknown>[] = [];
    let firstRead: QueryId | undefined;
    let paused = false;
    const pauseAfterRead: KyselyPlugin = {
      transformQuery(args) {
        // Observe the public table, not an implementation function or advisory-lock key.
        // Match both a query-builder TableNode and raw SQL fragments.
        if (firstRead === undefined && /\bledger_entries\b/i.test(JSON.stringify(args.node))) {
          firstRead = args.queryId;
        }
        return args.node;
      },
      async transformResult(args) {
        if (!paused && args.queryId === firstRead) {
          paused = true;
          readCompleted.resolve();
          await bounded(releaseA.promise, 'release A after its entry read');
        }
        return args.result;
      },
    };

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
      const resultA = runner
        .runDailyCheck(runA.withPlugin(pauseAfterRead), { accountingDate: DAY })
        .then(
          (value) => ({ status: 'fulfilled', value }) as const,
          (error: unknown) => ({ status: 'rejected', error }) as const,
        );
      running.push(resultA);
      await bounded(readCompleted.promise, 'A must finish reading ledger_entries');
      expect(paused).toBe(true);

      // In a split read/write implementation A is paused before writing daily_balances.
      // With atomic INSERT ... SELECT the same hook pauses after that statement, before COMMIT;
      // its read snapshot still predates these committed late entries.
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

      // Let B finish if no conflicting lock exists, otherwise prove it has reached A's lock.
      // Poll an observable condition with a deadline; a fixed sleep cannot establish ordering.
      await expect
        .poll(
          async () => {
            if (bFinished) return true;
            const waiting = await sql<{ blocked: boolean }>`
              SELECT ${pidA}::integer = ANY(pg_blocking_pids(${pidB}::integer)) AS blocked
            `.execute(db);
            return waiting.rows[0]!.blocked || bFinished;
          },
          { timeout: 10_000, interval: 20 },
        )
        .toBe(true);
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
