import type { DatabaseConnection, KyselyPlugin, QueryResult } from 'kysely';
import { expect, vi } from 'vitest';
import { factory, input, save, seedRow, type Harness, type Save, type Setup } from './kit.ts';

export async function auditFailure(h: Harness, f: Setup, body: Save) {
  let reached = false;
  let wroteVersion = false;
  const inserts = new WeakMap<object, string>();
  const fault: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (node.kind === 'InsertQueryNode' && node.into !== undefined) {
        inserts.set(queryId, node.into.table.identifier.name);
      }
      if (
        node.kind === 'UpdateQueryNode' &&
        JSON.stringify(node, (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ).includes('app_versions')
      ) {
        inserts.set(queryId, 'app_versions');
      }
      return node;
    },
    async transformResult({ result, queryId }) {
      if (inserts.get(queryId) === 'app_versions') wroteVersion = true;
      if (inserts.get(queryId) === 'audit_logs') {
        reached = true;
        throw new Error('synthetic audit persistence failure');
      }
      return result;
    },
  };
  // Keep the real pool: an incorrectly separate transaction must remain observable.
  const db = h.db.withPlugin(fault);
  const app = await (
    await factory()
  )('admin', {
    ...f.overrides,
    dbHandles: { db, dbRead: null, close: async () => undefined },
  });
  try {
    await app.init();
    const sent = await save({ app, token: f.token }, body);
    expect(wroteVersion, 'the row write completed before the injected audit failure').toBe(true);
    expect(reached, 'failure was injected after audit INSERT').toBe(true);
    return sent;
  } finally {
    await app.close();
  }
}

export async function changeAfterPreRead(h: Harness, f: Setup, exists: boolean) {
  return h.db.connection().execute(async (db) => {
    const connection = await db.getExecutor().provideConnection(async (value) => value);
    const execute = connection.executeQuery.bind(connection);
    const app = await (
      await factory()
    )('admin', {
      ...f.overrides,
      dbHandles: { db, dbRead: null, close: async () => undefined },
    });
    let changed = false;
    let locked = false;
    const spy = vi
      .spyOn(connection, 'executeQuery')
      .mockImplementation(
        async <R>(
          ...args: Parameters<DatabaseConnection['executeQuery']>
        ): Promise<QueryResult<R>> => {
          const [query] = args;
          const versionRead =
            query.query.kind === 'SelectQueryNode' && /\bapp_versions\b/i.test(query.sql);
          if (versionRead && /\bfor update\b/i.test(query.sql)) locked = true;
          const result = await execute<R>(...args);
          if (!changed && versionRead) {
            expect(
              locked,
              'the operation tier is selected using an unlocked primary pre-read',
            ).toBe(false);
            changed = true;
            if (exists) {
              await h.db
                .updateTable('app_versions')
                .set({ min_supported_version: null, row_version: 1, update_title: '并发变更' })
                .where('app_id', '=', f.appId)
                .execute();
            } else {
              await seedRow(h, f.appId, { update_title: '并发变更' });
            }
          }
          return result;
        },
      );
    try {
      await app.init();
      // The supplied expected version matches the row AFTER the concurrent change. A CAS-only
      // implementation accepts it; Y1's separate pre-read consistency check must reject it.
      const sent = await save(
        { app, token: f.token },
        input({
          expected_row_version: exists ? 1 : 0,
          min_supported_version: exists ? '1.1.0' : null,
        }),
      );
      expect(changed, 'the test reached the pre-read interleaving').toBe(true);
      expect(locked, 'the transaction reads its current row FOR UPDATE').toBe(true);
      return sent;
    } finally {
      spy.mockRestore();
      await app.close();
    }
  });
}
