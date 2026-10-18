// 沿用 kill-switches/ordered-race.ts 的数据库边界控制：普通读完成后暂停，
// 原子写 / FOR UPDATE 取锁前暂停。第二个 HTTP 请求必须先完成，不能用串行调用冒充并发。
import type { DatabaseConnection, QueryResult } from 'kysely';
import { expect, vi } from 'vitest';
import { factory, type Harness, type HttpApp } from '../../admin/auth/kit.ts';
import { send, type Sent, type Setup, type Write } from './kit.ts';

export interface Attempt {
  op: Write;
  body: Record<string, unknown>;
}

export async function onConnection<T>(
  h: Harness,
  f: Setup,
  run: (app: HttpApp, connection: DatabaseConnection) => Promise<T>,
): Promise<T> {
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
      return await run(app, connection);
    } finally {
      await app.close();
    }
  });
}

export async function orderedRace(
  h: Harness,
  f: Setup,
  key: string,
  first: Attempt,
  second: Attempt,
  existing: boolean,
) {
  return onConnection(h, f, async (app, connection) => {
    const execute = connection.executeQuery.bind(connection);
    let entered = false;
    let timedOut = false;
    let secondSent: Sent | undefined;
    const runSecond = async () => {
      entered = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        secondSent = await Promise.race([
          send(f, second.op, key, second.body),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error('page CAS: second request timed out'));
            }, 5000);
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
          if (!entered && /\bpages\b|\bpage_versions\b/.test(query.sql)) {
            if (
              existing &&
              query.query.kind === 'InsertQueryNode' &&
              query.query.onConflict?.doNothing
            )
              return execute<R>(...args);
            const plainRead = query.query.kind === 'SelectQueryNode' && !/\bfor\b/i.test(query.sql);
            if (plainRead && /\bpages\b/.test(query.sql) && /\brevision\b|\*/.test(query.sql)) {
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
      const firstSent = await send({ ...f, app }, first.op, key, first.body);
      expect(timedOut, '第二个请求须在暂停期间完成').toBe(false);
      expect(entered, '须命中页面数据库边界').toBe(true);
      expect(secondSent).toBeDefined();
      return { first: firstSent, second: secondSent! };
    } finally {
      spy.mockRestore();
    }
  });
}
