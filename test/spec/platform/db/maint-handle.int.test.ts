// Rule tests for the maintenance handle against a real PostgreSQL (task B1-01n; contract sections
// 1–3 of apps/api/src/modules/platform/db/maint.ts). Basis: ADR-0001 §4.2 第 4 项 (worker 定时任务以
// couli_maint 调用 SECURITY DEFINER 函数建和删分区), 第 8 项 (couli_maint 只有分区函数的 EXECUTE), 第 11
// 项 (每进程连接池), 第 3 项 (int8 → BigInt); ADR-0002 §5 (强制 SSL; 出错后重建连接); 规划/02 §15.1 PG
// 一行. One clone of the migrated template for this file; sessions are observed through
// pg_stat_activity from a connection of the same role. Top-level it() only (规划/11 §4.3).
import { createDb, destroyDb, type DB } from '@couli/db';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  createDbHandles,
  loadConnectionConfig,
} from '../../../../apps/api/src/modules/platform/db/index.ts';
import {
  createMaintDbHandle,
  loadMaintConnectionConfig,
  type MaintDbHandle,
} from '../../../../apps/api/src/modules/platform/db/maint.ts';
import { createPartitionMaintenance } from '../../../../apps/api/src/modules/platform/maintenance/index.ts';
import { describeError, line, memoryLogger, reduceLine, rejectionProblems } from './kit.ts';

let database: TestDatabase;
const observers: Kysely<DB>[] = [];

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  for (const observer of observers) await destroyDb(observer);
  await database.drop();
});

function observer(role: 'couli_maint' | 'couli_app'): Kysely<DB> {
  const db = createDb({ connectionString: database.urlFor(role), max: 2 });
  observers.push(db);
  return db;
}

/** The maintenance handle of the worker for `url` (APP_ENV=test) and its memory log. */
function maintHandle(
  url: string,
  closeTimeoutMs?: number,
): { handle: MaintDbHandle; lines: string[] } {
  const { logger, lines } = memoryLogger('worker');
  const config = loadMaintConnectionConfig('worker', {
    APP_ENV: 'test',
    DATABASE_MAINT_URL: url,
  });
  if (config === null) throw new Error('loader returned null for a set URL');
  const handle =
    closeTimeoutMs === undefined
      ? createMaintDbHandle(config, { logger })
      : createMaintDbHandle(config, { logger, closeTimeoutMs });
  return { handle, lines };
}

/** Sessions of this database named `applicationName`, as seen by `db`. */
async function sessions(db: Kysely<DB>, applicationName: string): Promise<number> {
  const result = await sql<{ n: bigint }>`
    SELECT count(*) AS n FROM pg_stat_activity
    WHERE datname = current_database() AND application_name = ${applicationName}
  `.execute(db);
  return Number(result.rows[0]?.n ?? -1n);
}

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

interface Facts {
  readonly connections: number;
  readonly apps: string[];
  readonly users: string[];
  readonly readOnly: string[];
}

/** Runs `count` overlapping queries and reports the distinct sessions that served them. */
async function poolFacts(db: Kysely<DB>, count: number): Promise<Facts> {
  const rows = await Promise.all(
    Array.from({ length: count }, async () => {
      const result = await sql<{ pid: number; app: string; who: string; ro: string }>`
        SELECT pg_backend_pid() AS pid, current_setting('application_name') AS app,
               current_user AS who, current_setting('default_transaction_read_only') AS ro
        FROM pg_sleep(0.1)
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

it('[ADR-0001 §4.2 #4、#8、#11、#3] 维护池确切为 1 个连接、以 couli_maint 连接、会话名 couli-worker-maint、可写、int8 为 BigInt；能以它跑一轮分区维护（预建 8 个分区、无失败）；同时 worker 的主库池照旧是 couli_app / couli-worker、上限 10；close() 后维护会话消失，全程不写日志', async () => {
  let seen: unknown;
  const maintObserver = observer('couli_maint');
  try {
    const { handle, lines } = maintHandle(database.urlFor('couli_maint'));
    const main = createDbHandles(
      loadConnectionConfig('worker', {
        DATABASE_URL: database.urlFor('couli_app'),
        REDIS_URL: 'redis://127.0.0.1:1/0',
      }),
      { logger: memoryLogger('worker').logger },
    );
    const [maintFacts, mainFacts] = await Promise.all([
      poolFacts(handle.db, 4),
      poolFacts(main.db, 12),
    ]);
    const int8 = await sql<{ big: bigint; list: bigint[] }>`
      SELECT ${sql.lit(BIG.toString())}::int8 AS big, ARRAY[1, ${sql.lit(BIG.toString())}]::int8[] AS list
    `.execute(handle.db);
    const { logger: runLogger } = memoryLogger('worker');
    const report = await createPartitionMaintenance({
      db: handle.db,
      logger: runLogger,
      clock: { now: () => new Date('2026-11-20T03:04:05Z') },
    }).runOnce();
    const closed = await handle.close();
    await main.close();
    const gone = await until(
      async () => (await sessions(maintObserver, 'couli-worker-maint')) === 0,
      3000,
    );
    seen = {
      maintFacts,
      mainFacts,
      int8: int8.rows[0],
      report: { ensured: report.ensured.length, failed: report.failed },
      closed,
      gone,
      lines,
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toStrictEqual({
    maintFacts: {
      connections: 1,
      apps: ['couli-worker-maint'],
      users: ['couli_maint'],
      readOnly: ['off'],
    },
    mainFacts: { connections: 10, apps: ['couli-worker'], users: ['couli_app'], readOnly: ['off'] },
    int8: { big: BIG, list: [1n, BIG] },
    report: { ensured: 8, failed: 0 },
    closed: undefined,
    gone: true,
    lines: [],
  });
});

it('[ADR-0002 §5「出错后重建连接」; db 契约 5] 服务端结束空闲的维护会话（pg_terminate_backend）：进程不退出，确切一行 error db_pool_error（pool 为 dbMaint、code 57P01），不带错误对象与口令；下一条查询换新连接照常', async () => {
  let seen: unknown;
  const maintObserver = observer('couli_maint');
  const url = database.urlFor('couli_maint');
  const phrase = decodeURIComponent(new URL(url).password);
  try {
    const { handle, lines } = maintHandle(url);
    const first = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(handle.db);
    const pid = first.rows[0]?.pid ?? -1;
    await sql`SELECT pg_terminate_backend(${pid})`.execute(maintObserver);
    const logged = await until(async () => Promise.resolve(lines.length > 0), 3000);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    const next = await sql<{ pid: number; who: string }>`
      SELECT pg_backend_pid() AS pid, current_user AS who
    `.execute(handle.db);
    await handle.close();
    seen = {
      logged,
      lines: lines.map((raw) => reduceLine(raw, process.pid)),
      passwordInLog: phrase !== '' && lines.join('').includes(phrase),
      newSession: (next.rows[0]?.pid ?? pid) !== pid,
      who: next.rows[0]?.who,
    };
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toStrictEqual({
    logged: true,
    lines: [line('worker', 'error', { pool: 'dbMaint', code: '57P01' }, 'db_pool_error')],
    passwordInLog: false,
    newSession: true,
    who: 'couli_maint',
  });
});

it('[ADR-0001 §4.2 #11; db 契约 6] 关闭超时：确认维护查询已在服务端运行后 close()，closeTimeoutMs（300）到点仍在跑的查询从客户端关掉——确切一行 warn db_close_timeout（pool 为 dbMaint、busy 1），那条查询被拒绝，close() 按时完成；之后的请求以 DbError closed 拒绝', async () => {
  let seen: unknown;
  try {
    const { handle, lines } = maintHandle(database.urlFor('couli_maint'), 300);
    const slow = sql`SELECT pg_sleep(5)`.execute(handle.db).then(
      () => 'resolved',
      () => 'rejected',
    );
    // close() only after the query is really running on the server (connection established).
    const watcher = observer('couli_maint');
    const running = await until(async () => {
      const result = await sql<{ n: bigint }>`
        SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = 'couli-worker-maint'
          AND state = 'active' AND query LIKE '%pg_sleep(5)%'
      `.execute(watcher);
      return Number(result.rows[0]?.n ?? 0n) === 1;
    }, 5000);
    const began = performance.now();
    const closed = await handle.close();
    const elapsed = performance.now() - began;
    seen = {
      running,
      closed,
      inTime: elapsed < 2000,
      slow: await slow,
      after: await rejectionProblems(sql`SELECT 1`.execute(handle.db), 'closed'),
      lines: lines.map((raw) => reduceLine(raw, process.pid)),
    };
    // The server-side backend of the force-closed query still sleeps: end it for later tests.
    await sql`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = 'couli-worker-maint'
    `.execute(watcher);
  } catch (error) {
    seen = describeError(error);
  }
  expect(seen).toStrictEqual({
    running: true,
    closed: undefined,
    inTime: true,
    slow: 'rejected',
    after: [],
    lines: [line('worker', 'warn', { pool: 'dbMaint', busy: 1 }, 'db_close_timeout')],
  });
});

it('[ADR-0002 §5 强制 SSL; 路径 B 契约补充 2] 对不开 TLS 的测试库：维护连接串带 sslmode=require 或 verify-full 时查询以「The server does not support SSL connections」失败、不退回明文（库里不多出维护会话）；sslmode=disable 照常连上', async () => {
  const url = database.urlFor('couli_maint');
  const maintObserver = observer('couli_maint');
  const outcome = async (query: string): Promise<string> => {
    try {
      const { handle } = maintHandle(`${url}?${query}`);
      try {
        const result = await sql<{ who: string }>`SELECT current_user AS who`.execute(handle.db);
        return `connected as ${String(result.rows[0]?.who)}`;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      } finally {
        await handle.close();
      }
    } catch (error) {
      return describeError(error);
    }
  };
  // Earlier tests of this file may leave a server-side session behind (a force-closed query).
  const before = await sessions(maintObserver, 'couli-worker-maint');
  const required = await outcome('sslmode=require');
  const verifyFull = await outcome('sslmode=verify-full');
  const plainSessions = (await sessions(maintObserver, 'couli-worker-maint')) - before;
  const disable = await outcome('sslmode=disable');
  expect({ required, verifyFull, plainSessions, disable }).toStrictEqual({
    required: 'The server does not support SSL connections',
    verifyFull: 'The server does not support SSL connections',
    plainSessions: 0,
    disable: 'connected as couli_maint',
  });
});
