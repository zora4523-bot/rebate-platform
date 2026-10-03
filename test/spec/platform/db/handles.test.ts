// Rule tests for createDbHandles and close() without a database (ADR-0001 §4.2 第 11 项: 主库 db
// 与只读 dbRead, 只有 admin 有 dbRead; contract sections 4, 6 and 7 of
// apps/api/src/modules/platform/db/index.ts). The URLs point at 127.0.0.1:1, where nothing
// listens; every test also counts the connection attempts of all sockets of the process, which
// must stay 0 (creating the handles connects nowhere, and nothing connects after close()).
// Unit tests: no database, no port. Top-level it() only (规划/11 §4.3).
import { sql, Kysely } from 'kysely';
import { expect, it } from 'vitest';
import {
  createDbHandles,
  loadConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  ENTRIES,
  dbErrorProblems,
  describeError,
  envFor,
  memoryLogger,
  rejectionProblems,
  turns,
  urlsOf,
  watchSocketConnects,
  type Entry,
} from './kit.ts';

function handlesFor(entry: Entry, label: string, closeTimeoutMs?: number) {
  const { logger, lines } = memoryLogger(entry);
  const config = loadConnectionConfig(entry, envFor(entry, urlsOf(label).env));
  const handles =
    closeTimeoutMs === undefined
      ? createDbHandles(config, { logger })
      : createDbHandles(config, { logger, closeTimeoutMs });
  return { handles, lines };
}

function kyselyView(value: unknown): unknown {
  if (value === null) return null;
  if (!(value instanceof Kysely)) return `not a Kysely instance: ${String(value)}`;
  return {
    prototype: Object.getPrototypeOf(value) === Kysely.prototype,
    ownKeys: Reflect.ownKeys(value).map(String),
  };
}

for (const entry of ENTRIES) {
  it(`[ADR-0001 §4.2 #11] ${entry}：句柄对象正好有 db、dbRead、close 三个自有属性且冻结；db 是 Kysely 实例，dbRead ${entry === 'admin' ? '是另一个 Kysely 实例' : '为 null'}；创建时不连库、不写日志`, async () => {
    const sockets = watchSocketConnects();
    let seen: unknown;
    try {
      const { handles, lines } = handlesFor(entry, `shape.${entry}`);
      await turns();
      seen = {
        plain: Object.getPrototypeOf(handles) === Object.prototype,
        frozen: Object.isFrozen(handles),
        keys: Reflect.ownKeys(handles).map(String).sort(),
        close: typeof handles.close,
        db: kyselyView(handles.db),
        dbRead: kyselyView(handles.dbRead),
        distinct: handles.dbRead !== handles.db,
        connectsAfterCreate: sockets.count(),
        closed: await rejectionFreeClose(handles),
        connectsAfterClose: sockets.count(),
        lines,
      };
    } catch (error) {
      seen = describeError(error);
    } finally {
      sockets.restore();
    }
    const kysely = { prototype: true, ownKeys: [] };
    expect(seen).toStrictEqual({
      plain: true,
      frozen: true,
      keys: ['close', 'db', 'dbRead'],
      close: 'function',
      db: kysely,
      dbRead: entry === 'admin' ? kysely : null,
      distinct: true,
      connectsAfterCreate: 0,
      closed: 'resolved undefined',
      connectsAfterClose: 0,
      lines: [],
    });
  });
}

async function rejectionFreeClose(handles: DbHandles): Promise<string> {
  try {
    const value = await handles.close();
    return `resolved ${String(value)}`;
  } catch (error) {
    return describeError(error);
  }
}

/** Every way of asking a handle for a connection, as promises (created when called). */
function requests(db: DbHandles['db']): Promise<unknown>[] {
  return [
    db.selectFrom('processed_events').selectAll().execute(),
    db.selectNoFrom((eb) => eb.lit(1).as('one')).executeTakeFirst(),
    sql`SELECT 1`.execute(db),
    db.transaction().execute(async (trx) => trx.selectFrom('event_log').selectAll().execute()),
    db.connection().execute(async (conn) => sql`SELECT 2`.execute(conn)),
    db.insertInto('processed_events').values({ consumer: 'x', event_id: 'y' }).execute(),
  ];
}

for (const entry of ENTRIES) {
  it(`[ADR-0001 §4.2 #11] ${entry}：从没查询过就 close()，之后每种取连接的方式（查询、原始 SQL、事务、connection()、写入）都以 DbError closed 拒绝${entry === 'admin' ? '（db 与 dbRead 都是）' : ''}，不发起任何连接（Kysely 自己的 destroy 在未初始化时什么也不做）`, async () => {
    const sockets = watchSocketConnects();
    let seen: unknown;
    try {
      const { handles, lines } = handlesFor(entry, `after-close.${entry}`);
      await handles.close();
      const dbOutcomes = await Promise.all(
        requests(handles.db).map((request) => rejectionProblems(request, 'closed')),
      );
      const readOutcomes =
        handles.dbRead === null
          ? null
          : await Promise.all(
              requests(handles.dbRead).map((request) => rejectionProblems(request, 'closed')),
            );
      await turns();
      seen = { dbOutcomes, readOutcomes, connects: sockets.count(), lines };
    } catch (error) {
      seen = describeError(error);
    } finally {
      sockets.restore();
    }
    const none = [[], [], [], [], [], []];
    expect(seen).toStrictEqual({
      dbOutcomes: none,
      readOutcomes: entry === 'admin' ? none : null,
      connects: 0,
      lines: [],
    });
  });
}

it('[ADR-0001 §4.2 #11] close() 之后、它完成之前（同一拍里）发出的请求同样以 DbError closed 拒绝；admin 的 db 与 dbRead 都是', async () => {
  const sockets = watchSocketConnects();
  let seen: unknown;
  try {
    const { handles, lines } = handlesFor('admin', 'during-close');
    const closing = handles.close();
    const fromDb = requests(handles.db).map((request) => rejectionProblems(request, 'closed'));
    const fromRead = requests(handles.dbRead as DbHandles['db']).map((request) =>
      rejectionProblems(request, 'closed'),
    );
    const closed = await closing.then(
      (value) => `resolved ${String(value)}`,
      (error: unknown) => describeError(error),
    );
    seen = {
      closed,
      fromDb: await Promise.all(fromDb),
      fromRead: await Promise.all(fromRead),
      connects: sockets.count(),
      lines,
    };
  } catch (error) {
    seen = describeError(error);
  } finally {
    sockets.restore();
  }
  const none = [[], [], [], [], [], []];
  expect(seen).toStrictEqual({
    closed: 'resolved undefined',
    fromDb: none,
    fromRead: none,
    connects: 0,
    lines: [],
  });
});

it('[ADR-0001 §4.2 #11] close() 幂等：并发两次与事后第三次都以 undefined 完成、不抛；没有连接在用时立刻完成（远短于默认的 5000 毫秒关闭时限）', async () => {
  let seen: unknown;
  try {
    const { handles, lines } = handlesFor('admin', 'idempotent');
    const began = performance.now();
    const first = handles.close();
    const second = handles.close();
    const both = await Promise.all([first, second]);
    const third = await handles.close();
    const elapsed = performance.now() - began;
    seen = { both, third, fast: elapsed < 1000, lines };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toStrictEqual({
    both: [undefined, undefined],
    third: undefined,
    fast: true,
    lines: [],
  });
});

it('[ADR-0001 §4.2 #11; 教训 RESUME §8] closeTimeoutMs 只收 1 到 60000 的整数：0、-0、负数、60001、小数、NaN、±Infinity、字符串、null、2^53 都抛 DbError invalid_option（文案确切）；1、60000 与省略都可以', async () => {
  const invalid: unknown[] = [
    0,
    -0,
    -1,
    60001,
    1.5,
    59999.5,
    NaN,
    Infinity,
    -Infinity,
    '100',
    null,
    2 ** 53,
  ];
  let seen: unknown;
  try {
    const config = loadConnectionConfig('api', envFor('api', urlsOf('bounds').env));
    const { logger, lines } = memoryLogger('api');
    const outcomes = invalid.map((value) => {
      try {
        const handles = createDbHandles(config, { logger, closeTimeoutMs: value as number });
        void handles.close();
      } catch (error) {
        return dbErrorProblems(error, 'invalid_option');
      }
      return ['returned'];
    });
    const accepted: string[] = [];
    for (const value of [1, 60000, undefined]) {
      try {
        const handles =
          value === undefined
            ? createDbHandles(config, { logger })
            : createDbHandles(config, { logger, closeTimeoutMs: value });
        await handles.close();
        accepted.push('ok');
      } catch (error) {
        accepted.push(describeError(error));
      }
    }
    seen = { outcomes, accepted, lines };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toStrictEqual({
    outcomes: invalid.map(() => []),
    accepted: ['ok', 'ok', 'ok'],
    lines: [],
  });
});
