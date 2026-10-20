// Stop request A AFTER it reads the state changed by B. Run B until it either commits or
// PostgreSQL reports it blocked on A; then resume A. No guessed sleep determines correctness.
// A shared transaction lock makes B wait; a check outside the transaction exposes a stale read.
import { sql, type DatabaseConnection, type QueryResult } from 'kysely';
import { expect, vi } from 'vitest';
import { factory, type Harness, type Response } from '../../admin/auth/kit.ts';
import type { Request, Setup } from './kit.ts';

const bigintSafe = (_key: string, value: unknown): unknown =>
  typeof value === 'bigint' ? value.toString() : value;

export async function orderedRace(
  h: Harness,
  f: Setup,
  first: Request,
  second: Request,
  readKey: string,
) {
  return h.db.connection().execute((dbA) =>
    h.db.connection().execute(async (dbB) => {
      const connection = await dbA.getExecutor().provideConnection(async (value) => value);
      const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(dbB);
      const pid = rows[0]!.pid;
      const firstPid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(dbA))
        .rows[0]!.pid;
      const makeApp = await factory();
      const appA = await makeApp('admin', {
        ...f.overrides,
        dbHandles: { db: dbA, dbRead: null, close: async () => undefined },
      });
      const appB = await makeApp('admin', {
        ...f.overrides,
        dbHandles: { db: dbB, dbRead: null, close: async () => undefined },
      });
      let pending: Promise<Response> | undefined;
      let entered = false;
      let finished = false;
      const execute = connection.executeQuery.bind(connection);
      try {
        await appA.init();
        await appB.init();
        const spy = vi
          .spyOn(connection, 'executeQuery')
          .mockImplementation(
            async <R>(
              ...args: Parameters<DatabaseConnection['executeQuery']>
            ): Promise<QueryResult<R>> => {
              const [query] = args;
              const result = await execute<R>(...args);
              const configRead =
                /^\s*select\b/iu.test(query.sql) && /\bconfig_items\b/u.test(query.sql);
              const mentionsOther =
                query.sql.includes(readKey) ||
                // Orchestrator mechanical fix: int8 columns arrive as BigInt.
                JSON.stringify(query.parameters, bigintSafe).includes(readKey) ||
                JSON.stringify(result.rows, bigintSafe).includes(readKey);
              if (!entered && configRead && mentionsOther) {
                entered = true;
                pending = second(appB).then((response) => {
                  finished = true;
                  return response;
                });
                const deadline = performance.now() + 5_000;
                let blocked = false;
                while (!finished && !blocked && performance.now() < deadline) {
                  const state = await sql<{ blocked: boolean }>`
                select ${firstPid} = any(pg_blocking_pids(${pid})) as blocked
              `.execute(h.db);
                  blocked = state.rows[0]!.blocked;
                  if (!finished && !blocked)
                    await new Promise((resolve) => setTimeout(resolve, 10));
                }
                expect(
                  finished || blocked,
                  'B must complete or reach a real PG lock, not just time out',
                ).toBe(true);
              }
              return result;
            },
          );
        try {
          const firstResponse = await first(appA);
          // Missing registration/check fails as an assertion rather than a hanging barrier.
          expect(entered, `A must read ${readKey} before writing`).toBe(true);
          expect(pending).toBeDefined();
          return { first: firstResponse, second: await pending! };
        } finally {
          spy.mockRestore();
          await pending;
        }
      } finally {
        await appA.close();
        await appB.close();
      }
    }),
  );
}
