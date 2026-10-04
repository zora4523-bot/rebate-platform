// Rule tests for the database handles against a real PostgreSQL (ADR-0001 §4.2 第 11 项 连接池:
// 每进程池大小、只读 dbRead; ADR-0002 §5: 角色与端口、TCP keepalive; ADR-0001 §4.2 第 3 项 int8 →
// BigInt; contract sections 4–6 of apps/api/src/modules/platform/db/index.ts). Each test file gets
// its own clone of the migrated template (ADR-0001 §4.2 #9) and connects as the business roles,
// never as a superuser. Sessions are observed through pg_stat_activity by their application_name,
// from a connection of the same role. Top-level it() only (规划/11 §4.3).
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { inspect } from 'node:util';
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  createDbHandles,
  loadConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  ENTRIES,
  SIZES,
  describeError,
  envFor,
  leaksIn,
  line,
  memoryLogger,
  pgUrlOf,
  phraseOf,
  reduceLine,
  rejectionProblems,
  settled,
  watchSocketConnects,
  type Entry,
} from './kit.ts';

type Role = 'couli_app' | 'couli_payout' | 'couli_readonly';

let database: TestDatabase;
const observers = new Map<Role, Kysely<DB>>();

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  for (const observer of observers.values()) await destroyDb(observer);
  await database.drop();
});

function roleOf(entry: Entry): Role {
  return entry === 'payout' ? 'couli_payout' : 'couli_app';
}

/** The variables `entry` requires, pointing at the test database (Redis is never contacted). */
function testEnv(entry: Entry, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...envFor(entry, {
      DATABASE_URL: database.urlFor(roleOf(entry)),
      DATABASE_READ_URL: database.urlFor('couli_readonly'),
      REDIS_URL: 'redis://127.0.0.1:1/0',
    }),
    ...overrides,
  };
}

function observer(role: Role): Kysely<DB> {
  let db = observers.get(role);
  if (db === undefined) {
    db = createDb({ connectionString: database.urlFor(role), max: 2 });
    observers.set(role, db);
  }
  return db;
}

/** Sessions of this database with `applicationName`, as seen by a connection of `role`. */
async function sessions(role: Role, applicationName: string, state?: string): Promise<number> {
  const result = await sql<{ n: bigint }>`
    SELECT count(*) AS n FROM pg_stat_activity
    WHERE datname = current_database() AND application_name = ${applicationName}
      AND (${state ?? null}::text IS NULL OR state = ${state ?? null})
  `.execute(observer(role));
  return Number(result.rows[0]?.n ?? -1n);
}

/** Polls `check` every 25 ms until it returns true, for at most `limitMs`. */
async function until(check: () => Promise<boolean>, limitMs: number): Promise<boolean> {
  const stop = performance.now() + limitMs;
  for (;;) {
    if (await check()) return true;
    if (performance.now() > stop) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface PoolFacts {
  readonly connections: number;
  readonly apps: string[];
  readonly users: string[];
  readonly readOnly: string[];
}

/** Runs `max + 2` overlapping queries and reports the distinct sessions that served them. */
async function poolFacts(db: Kysely<DB>, max: number): Promise<PoolFacts> {
  const rows = await Promise.all(
    Array.from({ length: max + 2 }, async () => {
      const result = await sql<{ pid: number; app: string; who: string; ro: string }>`
        SELECT pg_backend_pid() AS pid, current_setting('application_name') AS app,
               current_user AS who, current_setting('default_transaction_read_only') AS ro
        FROM pg_sleep(0.15)
      `.execute(db);
      const row = result.rows[0];
      if (row === undefined) throw new Error('no row');
      return row;
    }),
  );
  const unique = (values: string[]): string[] => [...new Set(values)].sort();
  return {
    connections: new Set(rows.map((row) => row.pid)).size,
    apps: unique(rows.map((row) => row.app)),
    users: unique(rows.map((row) => row.who)),
    readOnly: unique(rows.map((row) => row.ro)),
  };
}

const BIG = 9007199254740993n;

async function int8Of(db: Kysely<DB>): Promise<unknown> {
  const result = await sql<{ big: bigint; list: bigint[] }>`
    SELECT ${sql.lit(BIG.toString())}::int8 AS big, ARRAY[1, ${sql.lit(BIG.toString())}]::int8[] AS list
  `.execute(db);
  return result.rows[0];
}

async function countOf(db: Kysely<DB>, consumer: string): Promise<unknown> {
  const row = await db
    .selectFrom('processed_events')
    .select((eb) => eb.fn.countAll<bigint>().as('n'))
    .where('consumer', '=', consumer)
    .executeTakeFirst();
  return row?.n;
}

/** The SQLSTATE a write is refused with, or `written` / what else happened. */
async function writeOutcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : describeError(error);
  }
  return 'written';
}

for (const entry of ENTRIES) {
  const sizes = SIZES[entry];
  it(`[ADR-0001 §4.2 #11; ADR-0002 §5] ${entry}：主库池上限确切为 ${String(sizes.db)}（多出的并发查询排队，不多开连接）${entry === 'admin' ? '、只读池确切为 5' : ''}；会话名、角色确切；db 可读可写、在 schema app、int8 为 BigInt；close() 后会话全部消失，全程不写日志`, async () => {
    const role = roleOf(entry);
    const consumer = `rule-test-size-${entry}`;
    const { logger, lines } = memoryLogger(entry);
    let seen: unknown;
    try {
      const handles = createDbHandles(loadConnectionConfig(entry, testEnv(entry)), { logger });
      const db = await poolFacts(handles.db, sizes.db);
      const inserted = await handles.db
        .insertInto('processed_events')
        .values({ consumer, event_id: randomUUID() })
        .executeTakeFirst();
      const read =
        handles.dbRead === null
          ? null
          : {
              pool: await poolFacts(handles.dbRead, 5),
              count: await countOf(handles.dbRead, consumer),
              int8: await int8Of(handles.dbRead),
            };
      const facts = {
        db,
        inserted: inserted.numInsertedOrUpdatedRows,
        count: await countOf(handles.db, consumer),
        int8: await int8Of(handles.db),
        read,
      };
      const closed = await handles.close();
      const gone = await until(
        async () =>
          (await sessions(role, `couli-${entry}`)) === 0 &&
          (entry !== 'admin' || (await sessions('couli_readonly', 'couli-admin-read')) === 0),
        3000,
      );
      seen = { ...facts, closed, gone, lines };
    } catch (error) {
      seen = describeError(error);
    }
    const int8 = { big: BIG, list: [1n, BIG] };
    expect(seen).toStrictEqual({
      db: { connections: sizes.db, apps: [`couli-${entry}`], users: [role], readOnly: ['off'] },
      inserted: 1n,
      count: 1n,
      int8,
      read:
        entry === 'admin'
          ? {
              pool: {
                connections: 5,
                apps: ['couli-admin-read'],
                users: ['couli_readonly'],
                readOnly: ['on'],
              },
              count: 1n,
              int8,
            }
          : null,
      closed: undefined,
      gone: true,
      lines: [],
    });
  });
}

it('[ADR-0001 §4.2 #11; ADR-0002 §5] admin 的 dbRead 只读：以 couli_readonly 连接、会话默认只读；写入、事务里写入、原始 SQL 写入都被 PG 以 25006 拒绝，之后照常可读；同时 db 可写', async () => {
  const consumer = 'rule-test-read-only';
  const { logger, lines } = memoryLogger('admin');
  let seen: unknown;
  try {
    const handles = createDbHandles(loadConnectionConfig('admin', testEnv('admin')), { logger });
    const dbRead = handles.dbRead as Kysely<DB>;
    const settings = await sql<{ who: string; dflt: string; tx: string }>`
      SELECT current_user AS who, current_setting('default_transaction_read_only') AS dflt,
             current_setting('transaction_read_only') AS tx
    `.execute(dbRead);
    const writes = {
      insert: await writeOutcome(() =>
        dbRead
          .insertInto('processed_events')
          .values({ consumer, event_id: randomUUID() })
          .execute(),
      ),
      inTransaction: await writeOutcome(() =>
        dbRead
          .transaction()
          .execute(async (trx) =>
            trx
              .insertInto('processed_events')
              .values({ consumer, event_id: randomUUID() })
              .execute(),
          ),
      ),
      raw: await writeOutcome(() =>
        sql`INSERT INTO app.processed_events (consumer, event_id) VALUES (${consumer}, ${randomUUID()})`.execute(
          dbRead,
        ),
      ),
    };
    const primary = await writeOutcome(() =>
      handles.db
        .insertInto('processed_events')
        .values({ consumer, event_id: randomUUID() })
        .execute(),
    );
    seen = {
      settings: settings.rows,
      writes,
      primary,
      readAfter: await countOf(dbRead, consumer),
      closed: await handles.close(),
      lines,
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toStrictEqual({
    settings: [{ who: 'couli_readonly', dflt: 'on', tx: 'on' }],
    writes: { insert: '25006', inTransaction: '25006', raw: '25006' },
    primary: 'written',
    readAfter: 1n,
    closed: undefined,
    lines: [],
  });
});

it('[ADR-0001 §4.2 #11] dbRead 的只读不依赖角色、也不被连接串改掉：DATABASE_READ_URL 指向可写的 couli_app 且带 options=-c default_transaction_read_only=off 时仍拒绝写入（25006）；连接串里的其他参数照样生效（db 与 dbRead 的 statement_timeout）', async () => {
  const consumer = 'rule-test-read-only-url';
  const readOptions = encodeURIComponent(
    '-c default_transaction_read_only=off -c statement_timeout=12345',
  );
  const dbOptions = encodeURIComponent('-c statement_timeout=23456');
  const { logger, lines } = memoryLogger('admin');
  let seen: unknown;
  try {
    const env = testEnv('admin', {
      DATABASE_URL: `${database.urlFor('couli_app')}?options=${dbOptions}`,
      DATABASE_READ_URL: `${database.urlFor('couli_app')}?options=${readOptions}`,
    });
    const handles = createDbHandles(loadConnectionConfig('admin', env), { logger });
    const dbRead = handles.dbRead as Kysely<DB>;
    const show = (db: Kysely<DB>) =>
      sql<{ who: string; dflt: string; timeout: string }>`
        SELECT current_user AS who, current_setting('default_transaction_read_only') AS dflt,
               current_setting('statement_timeout') AS timeout
      `.execute(db);
    seen = {
      read: (await show(dbRead)).rows,
      db: (await show(handles.db)).rows,
      insert: await writeOutcome(() =>
        dbRead
          .insertInto('processed_events')
          .values({ consumer, event_id: randomUUID() })
          .execute(),
      ),
      inTransaction: await writeOutcome(() =>
        dbRead
          .transaction()
          .execute(async (trx) =>
            trx
              .insertInto('processed_events')
              .values({ consumer, event_id: randomUUID() })
              .execute(),
          ),
      ),
      count: await countOf(handles.db, consumer),
      closed: await handles.close(),
      lines,
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toStrictEqual({
    read: [{ who: 'couli_app', dflt: 'on', timeout: '12345ms' }],
    db: [{ who: 'couli_app', dflt: 'off', timeout: '23456ms' }],
    insert: '25006',
    inTransaction: '25006',
    count: 0n,
    closed: undefined,
    lines: [],
  });
});

it('[ADR-0002 §5「连接池要开 TCP keepalive」] 每个新连接都开 TCP keepalive：admin 的 db 与 dbRead 各连一次，两个套接字都 setKeepAlive(true)', async () => {
  const { logger, lines } = memoryLogger('admin');
  let seen: unknown;
  const handles = (() => {
    try {
      return createDbHandles(loadConnectionConfig('admin', testEnv('admin')), { logger });
    } catch (error) {
      return describeError(error);
    }
  })();
  if (typeof handles === 'string') {
    seen = handles;
  } else {
    const sockets = watchSocketConnects();
    const keepAlive = vi.spyOn(net.Socket.prototype, 'setKeepAlive');
    try {
      await sql`SELECT 1`.execute(handles.db);
      await sql`SELECT 1`.execute(handles.dbRead as Kysely<DB>);
      seen = {
        connects: sockets.count(),
        keepAliveOn: keepAlive.mock.calls.filter((call) => call[0] === true).length,
      };
    } catch (error) {
      seen = describeError(error);
    } finally {
      sockets.restore();
      keepAlive.mockRestore();
      await handles.close();
    }
  }
  expect({ seen, lines }).toStrictEqual({ seen: { connects: 2, keepAliveOn: 2 }, lines: [] });
});

it('[ADR-0001 §4.2 #11] 优雅关闭：进行中的查询照常完成且 close() 等它；close() 调用后、完成前与完成后的新请求都以 DbError closed 拒绝；会话全部消失；不写日志', async () => {
  const { logger, lines } = memoryLogger('api');
  let seen: unknown;
  try {
    const handles = createDbHandles(loadConnectionConfig('api', testEnv('api')), { logger });
    const events: string[] = [];
    const inFlight = sql<{ seven: number }>`SELECT 7 AS seven FROM pg_sleep(0.6)`
      .execute(handles.db)
      .then((result) => {
        events.push('query');
        return result.rows[0]?.seven;
      });
    const running = await until(
      async () => (await sessions('couli_app', 'couli-api', 'active')) === 1,
      3000,
    );
    const began = performance.now();
    const closing = handles.close().then((value) => {
      events.push('close');
      return value;
    });
    const during = await Promise.all([
      rejectionProblems(sql`SELECT 1`.execute(handles.db), 'closed'),
      rejectionProblems(
        handles.db.transaction().execute(async (trx) => sql`SELECT 1`.execute(trx)),
        'closed',
      ),
      rejectionProblems(handles.db.selectFrom('event_log').selectAll().execute(), 'closed'),
    ]);
    const seven = await inFlight;
    const closed = await closing;
    const elapsed = performance.now() - began;
    const after = await rejectionProblems(sql`SELECT 1`.execute(handles.db), 'closed');
    const gone = await until(async () => (await sessions('couli_app', 'couli-api')) === 0, 3000);
    seen = { running, during, seven, closed, events, inTime: elapsed < 4000, after, gone, lines };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toStrictEqual({
    running: true,
    during: [[], [], []],
    seven: 7,
    closed: undefined,
    events: ['query', 'close'],
    inTime: true,
    after: [],
    gone: true,
    lines: [],
  });
});

it('[ADR-0001 §4.2 #11] 有空闲连接时关两次（并发）再关第三次：都以 undefined 完成、不抛；连接全部关闭；不写日志', async () => {
  const { logger, lines } = memoryLogger('admin');
  let seen: unknown;
  try {
    const handles = createDbHandles(loadConnectionConfig('admin', testEnv('admin')), { logger });
    await Promise.all([poolFacts(handles.db, 3), poolFacts(handles.dbRead as Kysely<DB>, 5)]);
    const open = [
      await sessions('couli_app', 'couli-admin'),
      await sessions('couli_readonly', 'couli-admin-read'),
    ];
    const both = await Promise.all([handles.close(), handles.close()]);
    const third = await handles.close();
    const gone = await until(
      async () =>
        (await sessions('couli_app', 'couli-admin')) === 0 &&
        (await sessions('couli_readonly', 'couli-admin-read')) === 0,
      3000,
    );
    seen = { open, both, third, gone, lines };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toStrictEqual({
    open: [3, 5],
    both: [undefined, undefined],
    third: undefined,
    gone: true,
    lines: [],
  });
});

it('[ADR-0001 §4.2 #11; 规划/02 §14] 关闭超时：closeTimeoutMs 到点仍在用的连接从客户端关掉，每个池一行 warn db_close_timeout（db 1、dbRead 2，确切）；那些查询被拒绝，未提交的事务由 PG 回滚；close() 按时完成', async () => {
  const consumer = 'rule-test-close-timeout';
  const { logger, lines } = memoryLogger('admin');
  let seen: unknown;
  try {
    const handles = createDbHandles(loadConnectionConfig('admin', testEnv('admin')), {
      logger,
      closeTimeoutMs: 300,
    });
    const dbRead = handles.dbRead as Kysely<DB>;
    const started = performance.now();
    const held = [
      settled(
        handles.db.transaction().execute(async (trx) => {
          await trx
            .insertInto('processed_events')
            .values({ consumer, event_id: randomUUID() })
            .execute();
          await sql`SELECT pg_sleep(1.5)`.execute(trx);
        }),
      ),
      settled(sql`SELECT pg_sleep(1.5)`.execute(dbRead)),
      settled(sql`SELECT pg_sleep(1.5)`.execute(dbRead)),
    ];
    const running = await until(
      async () =>
        (await sessions('couli_app', 'couli-admin', 'active')) === 1 &&
        (await sessions('couli_readonly', 'couli-admin-read', 'active')) === 2,
      3000,
    );
    const began = performance.now();
    const closed = await handles.close();
    const elapsed = performance.now() - began;
    const outcomes = await Promise.all(held);
    const after = await rejectionProblems(sql`SELECT 1`.execute(dbRead), 'closed');
    await sleep(Math.max(0, 2000 - (performance.now() - started)));
    seen = {
      running,
      closed,
      onTime: elapsed >= 295 && elapsed < 2500,
      outcomes: outcomes.map((outcome) =>
        outcome === 'resolved' || outcome.startsWith('DbError')
          ? outcome
          : 'rejected by the driver',
      ),
      after,
      committed: await countOf(observer('couli_app'), consumer),
      lines: lines.map((raw) => reduceLine(raw, process.pid)),
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toStrictEqual({
    running: true,
    closed: undefined,
    onTime: true,
    outcomes: ['rejected by the driver', 'rejected by the driver', 'rejected by the driver'],
    after: [],
    committed: 0n,
    lines: [
      line('admin', 'warn', { pool: 'db', busy: 1 }, 'db_close_timeout'),
      line('admin', 'warn', { pool: 'dbRead', busy: 2 }, 'db_close_timeout'),
    ],
  });
});

it('[规划/02 §12.6, §14] 连不上数据库：查询以驱动的错误（ECONNREFUSED）拒绝，错误里没有口令，不写日志，进程照常；之后的查询同样拒绝，close() 照常完成', async () => {
  const phrase = phraseOf('unreachable');
  const { logger, lines } = memoryLogger('payout');
  let seen: unknown;
  try {
    const handles: DbHandles = createDbHandles(
      loadConnectionConfig('payout', { DATABASE_URL: pgUrlOf('couli_payout', phrase) }),
      { logger },
    );
    const codes: unknown[] = [];
    const leaks: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await sql`SELECT 1`.execute(handles.db);
        codes.push('resolved');
      } catch (error) {
        codes.push((error as { code?: unknown }).code);
        leaks.push(
          ...leaksIn(`${inspect(error, { showHidden: true, depth: Infinity })}${String(error)}`, [
            phrase,
          ]),
        );
      }
    }
    seen = { codes, leaks, closed: await handles.close(), lines };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toStrictEqual({
    codes: ['ECONNREFUSED', 'ECONNREFUSED'],
    leaks: [],
    closed: undefined,
    lines: [],
  });
});
