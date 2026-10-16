// Deterministic interleaving of two PUT /admin/v1/kill-switches/{key} requests with the same
// expected_version, after test/spec/content/platform-icons/publish/ordered-race.ts (F1-06y): the
// first request runs on an app bound to one database connection and is stopped at its first
// config_items / config_item_versions statement; the second request runs to completion on the
// pooled app meanwhile, with a 5-second timeout so a pause can never hang the suite.
import type { DatabaseConnection, QueryResult } from 'kysely';
import { expect, vi } from 'vitest';
import { factory, type Harness } from '../../admin/auth/kit.ts';
import { put, type Caller, type Sent, type Setup } from './kit.ts';

export interface Attempt {
  readonly caller: Caller;
  readonly stepUpToken: string;
  readonly body: Record<string, unknown>;
}

export async function orderedRace(
  h: Harness,
  f: Setup,
  key: string,
  first: Attempt,
  second: Attempt,
  existingRow: boolean,
): Promise<{ first: Sent; second: Sent }> {
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
      let secondSent: Sent | undefined;
      let secondTimedOut = false;
      const runSecond = async () => {
        entered = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          secondSent = await Promise.race([
            put(f.app, second.caller, key, second.body, second.stepUpToken),
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
            const switchQuery = /\bconfig_items\b|\bconfig_item_versions\b/.test(query.sql);
            if (!entered && switchQuery) {
              if (
                existingRow &&
                query.query.kind === 'InsertQueryNode' &&
                query.query.onConflict?.doNothing
              ) {
                // An existing-row DO NOTHING neither reads the version nor locks the row; keep
                // going so the pause lands on the statement that does.
                return execute<R>(...args);
              }
              const plainRead =
                query.query.kind === 'SelectQueryNode' && !/\bfor\b/i.test(query.sql);
              if (plainRead) {
                // Keep the old result: a read / check / unconditional UPDATE then loses the race.
                const result = await execute<R>(...args);
                await runSecond();
                return result;
              }
              // Atomic UPDATE / INSERT / SELECT FOR UPDATE: pause BEFORE it takes a lock, so a
              // correct pessimistic implementation cannot deadlock against the second request.
              await runSecond();
            }
            return execute<R>(...args);
          },
        );
      try {
        const sent = await put(app, first.caller, key, first.body, first.stepUpToken);
        // HTTP error handling must not turn a timed-out pause into an accepted CAS conflict.
        expect(secondTimedOut, 'second request must complete while the first is paused').toBe(
          false,
        );
        expect(entered, 'first request must reach the controlled database boundary').toBe(true);
        expect(secondSent).toBeDefined();
        return { first: sent, second: secondSent! };
      } finally {
        spy.mockRestore();
      }
    } finally {
      await app.close();
    }
  });
}
