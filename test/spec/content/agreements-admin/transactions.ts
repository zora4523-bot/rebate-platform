// Controlled interleaving follows F1-02p §9.3 without importing another task's frozen kit.
import type { DatabaseConnection, KyselyPlugin, QueryResult } from 'kysely';
import { expect, vi } from 'vitest';
import {
  factory,
  input,
  publish,
  type Caller,
  type Harness,
  type Publish,
  type Sent,
  type Setup,
} from './kit.ts';

interface Attempt {
  caller: Caller;
  step: string;
}

export async function orderedRace(
  h: Harness,
  f: Setup,
  first: Attempt,
  second: Attempt,
  body: Publish,
) {
  return h.db.connection().execute(async (db) => {
    const connection = await db.getExecutor().provideConnection(async (value) => value);
    const app = await (
      await factory()
    )('admin', { ...f.overrides, dbHandles: { db, dbRead: null, close: async () => undefined } });
    try {
      await app.init();
      const execute = connection.executeQuery.bind(connection);
      let entered = false;
      let timedOut = false;
      let secondSent: Sent | undefined;
      const statements: string[] = [];
      async function runSecond() {
        entered = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          secondSent = await Promise.race([
            publish({ app: f.app, token: second.caller.token }, 'privacy', body, second.step),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                timedOut = true;
                reject(new Error('race deadline'));
              }, 5_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      const spy = vi
        .spyOn(connection, 'executeQuery')
        .mockImplementation(
          async <R>(
            ...args: Parameters<DatabaseConnection['executeQuery']>
          ): Promise<QueryResult<R>> => {
            const [query] = args;
            statements.push(query.sql);
            const advisory = /pg_advisory_xact_lock/i.test(query.sql);
            const agreements = /\bagreements\b/i.test(query.sql);
            if (!entered && (advisory || agreements)) {
              // With the prescribed lock, pause before acquiring it. A broken unlocked read
              // keeps its old result while the second transaction commits.
              if (
                !advisory &&
                query.query.kind === 'SelectQueryNode' &&
                !/\bfor\b/i.test(query.sql)
              ) {
                const stale = await execute<R>(...args);
                await runSecond();
                return stale;
              }
              await runSecond();
            }
            return execute<R>(...args);
          },
        );
      try {
        const firstSent = await publish(
          { app, token: first.caller.token },
          'privacy',
          body,
          first.step,
        );
        expect(timedOut, 'the second request must finish while the first is paused').toBe(false);
        expect(entered, 'publication reached a controlled database boundary').toBe(true);
        expect(secondSent).toBeDefined();
        const lockIndex = statements.findIndex((text) =>
          /pg_advisory_xact_lock.*hashtextextended/is.test(text),
        );
        const readIndex = statements.findIndex((text) => /\bagreements\b/i.test(text));
        expect(
          lockIndex,
          'first-version serialization uses the transaction advisory lock',
        ).toBeGreaterThanOrEqual(0);
        expect(lockIndex).toBeLessThan(readIndex);
        return { first: firstSent, second: secondSent! };
      } finally {
        spy.mockRestore();
      }
    } finally {
      await app.close();
    }
  });
}

export async function faultAt(
  h: Harness,
  f: Setup,
  target: 'agreements' | 'config_item_versions' | 'audit_logs',
  step: string,
): Promise<Sent> {
  let reached = false;
  const completedInserts: string[] = [];
  const tables = new WeakMap<object, string>();
  // Keep the real pool: binding the entire app to one connection would accidentally pull
  // incorrect out-of-transaction config writes into the publication's PG transaction.
  const fault: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (node.kind === 'InsertQueryNode' && node.into !== undefined) {
        tables.set(queryId, node.into.table.identifier.name);
      }
      return node;
    },
    async transformResult({ result, queryId }) {
      const table = tables.get(queryId);
      if (table !== undefined) completedInserts.push(table);
      if (table === target) {
        reached = true;
        if (target === 'agreements') {
          throw Object.assign(new Error('synthetic agreement unique conflict'), {
            code: '23505',
            constraint: 'agreements_app_type_version_key',
          });
        }
        throw new Error('synthetic publication persistence failure');
      }
      return result;
    },
  };
  const db = h.db.withPlugin(fault);
  const app = await (
    await factory()
  )('admin', { ...f.overrides, dbHandles: { db, dbRead: null, close: async () => undefined } });
  try {
    await app.init();
    const sent = await publish({ app, token: f.token }, 'privacy', input(), step);
    expect(reached, `fault reached ${target}, not an earlier rejection`).toBe(true);
    expect(completedInserts).toContain('articles');
    if (target === 'audit_logs') {
      expect(completedInserts).toContain('agreements');
      expect(completedInserts).toContain('config_item_versions');
    }
    return sent;
  } finally {
    await app.close();
  }
}
