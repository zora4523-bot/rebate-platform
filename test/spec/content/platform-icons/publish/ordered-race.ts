import type { DatabaseConnection, QueryResult } from 'kysely';
import { expect, vi } from 'vitest';
import { factory, type Harness, type Response } from '../../../admin/auth/kit.ts';
import { write, type Operation, type Setup } from './kit.ts';

interface Attempt {
  op: Operation;
  body: Record<string, unknown>;
}

/** The second HTTP request commits while the first is stopped at the database boundary. */
export async function orderedRace(h: Harness, f: Setup, first: Attempt, second: Attempt) {
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
      const revisionTable = first.op === 'source' ? 'platform_icon_versions' : 'platform_icons';
      let entered = false;
      let secondResponse: Response | undefined;
      const runSecond = async () => {
        entered = true;
        secondResponse = await write(f, second.op, second.body);
      };
      const spy = vi
        .spyOn(connection, 'executeQuery')
        .mockImplementation(
          async <R>(
            ...args: Parameters<DatabaseConnection['executeQuery']>
          ): Promise<QueryResult<R>> => {
            const [query] = args;
            const contentQuery = /\bplatform_icons\b|\bplatform_icon_versions\b/.test(query.sql);
            if (!entered && contentQuery) {
              const plainRead =
                query.query.kind === 'SelectQueryNode' && !/\bfor\b/i.test(query.sql);
              if (
                plainRead &&
                query.sql.includes(revisionTable) &&
                /\brevision\b|\*/.test(query.sql)
              ) {
                // Preserve the actual old result: an unsafe read/check/unconditional UPDATE loses.
                const result = await execute<R>(...args);
                await runSecond();
                return result;
              }
              if (!plainRead) {
                // Atomic UPDATE / INSERT / SELECT FOR UPDATE must pause BEFORE taking a lock.
                // Pausing afterwards would deadlock a correct pessimistic implementation.
                await runSecond();
              }
            }
            return execute<R>(...args);
          },
        );
      try {
        const firstResponse = await write({ ...f, app }, first.op, first.body);
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
