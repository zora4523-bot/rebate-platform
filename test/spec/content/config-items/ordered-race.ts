// Deterministic interleaving for the F1-10e CAS tests, after the frozen F1-06y helper
// (test/spec/content/platform-icons/publish/ordered-race.ts, only read, not imported): the second
// HTTP request runs to completion while the first is stopped at its first configuration-table
// statement — after a plain read (so a read / check / unconditional write loses), or before an
// atomic UPDATE / INSERT / SELECT … FOR UPDATE (so a correct pessimistic lock does not deadlock).
import type { DatabaseConnection, QueryResult } from 'kysely';
import { expect, vi } from 'vitest';
import { factory, type Harness, type Response } from '../../admin/auth/kit.ts';
import { call, type Call, type Operation, type Setup } from './kit.ts';

export interface Attempt {
  op: Operation;
  call: Call;
}

export async function orderedRace(
  h: Harness,
  f: Setup,
  first: Attempt,
  second: Attempt,
  existingRow: boolean,
) {
  return h.db.connection().execute(async (db) => {
    const connection = await db.getExecutor().provideConnection(async (value) => value);
    const app = await (
      await factory()
    )('admin', {
      ...f.overrides,
      dbHandles: { db, dbRead: null, close: async () => undefined },
    });
    try {
      await app.init();
      const execute = connection.executeQuery.bind(connection);
      let entered = false;
      let secondResponse: Response | undefined;
      let secondTimedOut = false;
      const runSecond = async () => {
        entered = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          secondResponse = await Promise.race([
            call(f, second.op, second.call),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                secondTimedOut = true;
                reject(new Error('orderedRace: second request did not finish within 5 seconds'));
              }, 5_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const spy = vi
        .spyOn(connection, 'executeQuery')
        .mockImplementation(
          async <R>(
            ...args: Parameters<DatabaseConnection['executeQuery']>
          ): Promise<QueryResult<R>> => {
            const [query] = args;
            const configQuery = /\bconfig_items\b|\bconfig_item_versions\b/.test(query.sql);
            if (!entered && configQuery) {
              if (
                existingRow &&
                query.query.kind === 'InsertQueryNode' &&
                query.query.onConflict?.doNothing
              ) {
                // An existing-row DO NOTHING neither reads the version nor locks the row.
                return execute<R>(...args);
              }
              const plainRead =
                query.query.kind === 'SelectQueryNode' && !/\bfor\b/i.test(query.sql);
              if (
                plainRead &&
                /\bconfig_items\b/.test(query.sql) &&
                /\bversion\b|\*/.test(query.sql)
              ) {
                const result = await execute<R>(...args);
                await runSecond();
                return result;
              }
              if (!plainRead) await runSecond();
            }
            return execute<R>(...args);
          },
        );
      try {
        const firstResponse = await call({ ...f, app }, first.op, first.call);
        expect(secondTimedOut, 'second request must complete while the first is paused').toBe(
          false,
        );
        expect(entered, 'first request must reach the controlled database boundary').toBe(true);
        expect(secondResponse).toBeDefined();
        return { first: firstResponse, second: secondResponse! };
      } finally {
        spy.mockRestore();
      }
    } finally {
      await app.close();
    }
  });
}
