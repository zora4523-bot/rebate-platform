// F1-02z: pin only the reader connection; the writer uses the remaining pool connections.
// A second agreement read waits for the first result and an independently committed insert.
import { randomUUID } from 'node:crypto';
import { CompiledQuery, type DatabaseConnection, type Kysely, type QueryResult } from 'kysely';
import type { DB } from '@couli/db';
import { vi } from 'vitest';
import { BODY, factory, type Harness, type HttpApp, type Setup } from './kit.ts';

export async function insertAgreement(h: Harness, f: Setup) {
  const articleId = randomUUID();
  await h.db.transaction().execute(async (tx) => {
    await tx
      .insertInto('articles')
      .values({
        id: articleId,
        app_id: f.appId,
        category: 'agreement',
        title: '并发首发协议',
        body: BODY,
        version: 1,
        status: 'published',
        published_at: f.clock.now(),
        notice_closable: false,
        notice_content_version: 1,
        row_version: 0,
        created_at: f.clock.now(),
        updated_at: f.clock.now(),
      })
      .execute();
    await tx
      .insertInto('agreements')
      .values({
        id: randomUUID(),
        app_id: f.appId,
        type: 'privacy',
        version: 1,
        min_version: 1,
        requires_resign: false,
        article_id: articleId,
        article_version: 1,
        text_sha256: 'a'.repeat(64),
        url: 'https://h5.example.test/legal/privacy/1',
        legal_confirmed_by: '法务甲',
        legal_confirm_note: '已确认原文',
        published_by: f.actor.id,
        published_at: f.clock.now(),
        created_at: f.clock.now(),
      })
      .execute();
  });
}

interface Mode {
  isolation: string;
  read_only: string;
}

export async function observeList<T>(
  h: Harness,
  f: Setup,
  beforeSecondRead: () => Promise<void>,
  work: (app: HttpApp, db: Kysely<DB>) => Promise<T>,
) {
  return h.db.connection().execute(async (connectionDb) => {
    const connection = await connectionDb.getExecutor().provideConnection(async (value) => value);
    let pending = 0;
    let parallel = false;
    const reads = new WeakSet<object>();
    const db = connectionDb.withPlugin({
      transformQuery({ node, queryId }) {
        if (
          node.kind === 'SelectQueryNode' &&
          (JSON.stringify(node.from) ?? '').includes('"name":"agreements"')
        ) {
          parallel ||= pending > 0;
          pending += 1;
          reads.add(queryId);
        }
        return node;
      },
      async transformResult({ result, queryId }) {
        if (reads.has(queryId)) pending -= 1;
        return result;
      },
    });
    const app = await (
      await factory()
    )('admin', {
      ...f.overrides,
      dbHandles: { db, dbRead: null, close: async () => undefined },
    });
    try {
      await app.init();
      const execute = connection.executeQuery.bind(connection);
      let readCount = 0;
      let injections = 0;
      let transaction = 0;
      let activeTransaction = 0;
      const observations: { transaction: number; mode: Mode | undefined }[] = [];
      const statements: string[] = [];
      const spy = vi
        .spyOn(connection, 'executeQuery')
        .mockImplementation(
          async <R>(
            ...args: Parameters<DatabaseConnection['executeQuery']>
          ): Promise<QueryResult<R>> => {
            const [query] = args;
            statements.push(query.sql);
            if (/^(begin|start transaction)\b/i.test(query.sql)) activeTransaction = ++transaction;
            if (
              query.query.kind === 'SelectQueryNode' &&
              /\bfrom\s+"app"\."agreements"/i.test(query.sql)
            ) {
              readCount += 1;
              if (readCount === 2) {
                injections += 1;
                await beforeSecondRead();
              }
              const mode = await execute<Mode>(
                CompiledQuery.raw(
                  "select current_setting('transaction_isolation') as isolation, current_setting('transaction_read_only') as read_only",
                ),
              );
              observations.push({ transaction: activeTransaction, mode: mode.rows[0] });
            }
            const result = await execute<R>(...args);
            if (/^(commit|rollback)\b/i.test(query.sql)) activeTransaction = 0;
            return result;
          },
        );
      try {
        const result = await work(app, db);
        return { result, readCount, injections, observations, statements, parallel, pending };
      } finally {
        spy.mockRestore();
      }
    } finally {
      await app.close();
    }
  });
}
