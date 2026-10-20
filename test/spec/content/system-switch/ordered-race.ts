// Observe the real connection, not a fake store. With a locking SELECT the rival runs
// before the lock is acquired; with an unlocked read it runs after that stale read.
// For an absent row the rival commits immediately before the first INSERT, exercising
// ON CONFLICT DO NOTHING followed by a fresh locking read.
import type { DB } from '@couli/db';
import type { DatabaseConnection, Kysely, QueryResult, Transaction } from 'kysely';
import { expect, vi } from 'vitest';

export async function orderedRace<T>(
  root: Kysely<DB>,
  existing: boolean,
  first: (trx: Transaction<DB>) => Promise<T>,
  rival: () => Promise<void>,
): Promise<T> {
  return root.connection().execute(async (db) => {
    const connection = await db.getExecutor().provideConnection(async (value) => value);
    const execute = connection.executeQuery.bind(connection);
    let entered = false;
    let timedOut = false;
    const selects: string[] = [];
    const runRival = async () => {
      entered = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          rival(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error('F1-02zk rival did not finish within 5 seconds'));
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
          const text = args[0].sql;
          const isSelect = /\bselect\b/i.test(text) && /\bconfig_items\b/i.test(text);
          if (isSelect) selects.push(text);
          if (!entered && existing && isSelect) {
            if (/\bfor\s+update\b/i.test(text)) {
              await runRival();
            } else {
              const stale = await execute<R>(...args);
              await runRival();
              return stale;
            }
          } else if (
            !entered &&
            !existing &&
            /\binsert\s+into\b/i.test(text) &&
            /\bconfig_items\b/i.test(text)
          ) {
            await runRival();
          }
          return execute<R>(...args);
        },
      );
    try {
      const result = await db.transaction().execute(first);
      expect(entered, 'the caller transaction reaches the controlled query').toBe(true);
      expect(timedOut, 'rival commits before the locking statement proceeds').toBe(false);
      expect(selects.length).toBeGreaterThanOrEqual(existing ? 1 : 2);
      for (const query of selects) expect(query).toMatch(/\bfor\s+update\b/i);
      return result;
    } finally {
      spy.mockRestore();
    }
  });
}
