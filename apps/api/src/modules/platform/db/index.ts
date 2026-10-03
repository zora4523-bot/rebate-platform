// Database handles of the five process entries (ADR-0001 §2 数据访问, §4.2 第 11 项 连接池,
// 第 20 项 payout 进程; ADR-0002 §5 连接方式; 规划/02 §3.1 生产拓扑, §12.6「数据库业务角色的口令」,
// §14 PostgreSQL 主库一行). The rule tests in test/spec/platform/db/**
// import this file by path; the names, signatures and semantics written here are the contract.
//
// 1. Variables per entry — `loadConnectionConfig(entry, env)`
//
//      entry    DATABASE_URL   DATABASE_READ_URL   REDIS_URL
//      api      required       ignored             required
//      stream   required       ignored             required
//      admin    required       required            required
//      worker   required       ignored             required
//      payout   required       ignored             ignored
//
//    Sources: every entry reads PostgreSQL (规划/02 §3.1; payout reads its switches from the PG
//    configuration table, ADR-0001 §4.2 #20). Only admin has `dbRead` (ADR-0001 §4.2 #11:
//    "admin 主库 3 加只读 5", "只读从库用单独的 dbRead，只有后台报表模块能引用"; ADR-0002 §5: admin
//    reports' dbRead connects as couli_readonly to the read-only port 5434). payout never reads
//    Redis (ADR-0001 §4.2 #20 "不读 Redis"; 规划/02 §3.1 payout row "不连 Redis"); the four other
//    entries use the cache, token buckets and anti-replay keys (规划/02 §3.1 Redis row).
//    待编排会话确认: (a) the name DATABASE_READ_URL — no document names this variable;
//    (b) REDIS_URL required for all four of api / stream / admin / worker — the documents only
//    say that payout does not use Redis.
//
//    - Reads only these three names of `env` (never `process.env`); a variable set to '' counts
//      as unset. An ignored variable is not read at all: whatever it holds (even a malformed
//      URL) changes nothing; any other variable changes nothing either.
//    - Problems, in the order DATABASE_URL, DATABASE_READ_URL, REDIS_URL, at most one each:
//        unset      `<NAME>: must be set for the <entry> entry`
//        malformed  DATABASE_URL and DATABASE_READ_URL:
//                   `<NAME>: must be a postgres:// or postgresql:// URL with a user, a host and a database name`
//                   valid = the WHATWG URL parser accepts it, protocol `postgres:` or
//                   `postgresql:`, non-empty username, non-empty hostname, pathname longer than
//                   '/' (the database name);
//                   REDIS_URL: `REDIS_URL: must be a redis:// or rediss:// URL with a host`
//                   valid = parses, protocol `redis:` or `rediss:`, non-empty hostname.
//      A message never contains any part of the value (it can carry the password). One or more
//      problems → throws `ConfigError` of platform/config with exactly that `problems` list (its
//      message is the one ConfigError builds from them); nothing else is attached (no `cause`).
//    - Returns a deeply frozen plain object whose own properties are exactly:
//        entry      the entry
//        db         { name: 'db', url: <DATABASE_URL>, max: POOL_SIZES[entry].db,
//                     applicationName: `couli-<entry>`, readOnly: false }
//        dbRead     admin: { name: 'dbRead', url: <DATABASE_READ_URL>, max: POOL_SIZES.admin.dbRead,
//                     applicationName: 'couli-admin-read', readOnly: true }; other entries: null
//        redisUrl   <REDIS_URL> for the four entries that require it; payout: null
//      where <NAME> is a `ConnectionUrl` of that variable. The application names are a choice of
//      this module (they make the sessions of each pool visible in pg_stat_activity).
//
// 2. Pool sizes — `POOL_SIZES` (ADR-0001 §4.2 #11: "api 10、stream 5、worker 10、payout 3、admin
//    主库 3 加只读 5，按数据库节点规格复核"; ADR-0002 §5: the sum is reviewed against the node size
//    before going live). These values live only in this constant (and in the rule tests); the
//    entries take them from here through `loadConnectionConfig`. No PgBouncer: the pools connect
//    directly (ADR-0001 §4.2 #11, ADR-0002 §5).
//
// 3. Connection URLs never show their password — `ConnectionUrl`
//    - `redacted`: protocol, `//`, the username, `:***` when the URL has a password, `@` when it
//      has a username or a password, the host (with its port) and the pathname. Query string and
//      fragment are dropped (a password can also be given as `?password=`, which pg honours).
//      Example: postgres://couli_app:***@127.0.0.1:5433/couli
//    - `reveal()`: the WHATWG serialisation (`new URL(value).href`) of the value, for the
//      driver or client that connects. Nothing else of this module returns it.
//    - `String(url)`, template literals and `toJSON()` give `redacted`; `util.inspect` gives
//      exactly `ConnectionUrl(<redacted>)` (also inside other objects, at any depth, with
//      showHidden). The value lives in a private field: `Reflect.ownKeys(url)` is empty and the
//      instance is not a Proxy.
//
// 4. Handles — `createDbHandles(config, options)`
//    - Checks `options` first: `closeTimeoutMs` (default 5 000) must be an integer from 1 to
//      60 000; anything else (NaN, ±Infinity, a fraction, a non-number) throws
//      DbError('invalid_option') and nothing is created. The default and the bounds are a choice
//      of this module (待编排会话确认): the stop grace of `docker stop` is 10 s.
//    - One pg pool per handle: `db` always, `dbRead` only when `config.dbRead` is not null (admin).
//      Each pool: max = `config.<handle>.max`; every session's application_name is
//      `config.<handle>.applicationName`; TCP keepalive on (`keepAlive: true`; ADR-0002 §5 "连接池
//      要开 TCP keepalive，出错后重建连接").
//    - `dbRead` is read-only (ADR-0001 §4.2 #11; ADR-0002 §5): couli_readonly is the role its URL
//      names in every environment, and in addition every session of the dbRead pool runs with
//      `default_transaction_read_only = on`, whatever its URL says — also when the URL names a
//      role that may write, and when it carries an `options` query parameter. Note: pg lets the
//      values of a connection string override the same keys of the pool config, so `options` in
//      the pool config alone is not enough; set it on each new session (Kysely's
//      onCreateConnection) or merge it in after parsing. A write through dbRead fails with
//      SQLSTATE 25006, also inside a transaction. `db` sessions stay read-write.
//    - Both handles are Kysely instances bound to schema `app` (`.withSchema('app')`) with int8
//      and int8[] parsed as BigInt (ADR-0001 §4.2 #3), as `createDb` of @couli/db does: extend
//      `createDb` (packages/db/src/index.ts is in the task paths; resolve its TODO) or build the
//      pool here. No second data-access library.
//    - Creating the handles opens no connection: the first query opens the first one. So the
//      entries start, and `smoke:entries` runs, without a database.
//    - Returns a frozen plain object whose own properties are exactly `db`, `dbRead` (a Kysely
//      instance for admin, otherwise null) and `close`. `db` and `dbRead` are plain Kysely
//      instances (prototype `Kysely.prototype`, no own properties); pools, URLs and connection
//      parameters stay private, so util.inspect and JSON of the handles show no password.
//
// 5. Connection errors — the pools never crash the process
//    - Each pool has an 'error' listener, and every connection has an 'error' listener for its
//      whole life, idle or checked out. pg-pool listens only while a connection is idle, and pg
//      emits 'error' on a checked-out connection whose server went away between two queries (an
//      open transaction): without a listener Node ends the process.
//    - A connection that fails while no query runs on it (the server ended it: pg_terminate_backend,
//      a failover of 规划/02 §14, a restart; or the network dropped) is logged as exactly ONE line
//      through `options.logger` itself (no child logger, no extra bindings): level error, message
//      `db_pool_error`, fields exactly `{ pool, code }` — pool is 'db' or 'dbRead'; code is the
//      `code` of the first error that connection reported when it is a string (SQLSTATE such as
//      '57P01', or a Node code such as 'ECONNRESET'), else null. Never the error object, its
//      message or stack, or connection parameters (pg attaches the client, which holds them).
//      The connection is dropped, the process keeps running, the next query opens a new one; a
//      transaction that was open on it rejects (with the driver's error).
//    - A connection that cannot be opened rejects the query that asked for it with the driver's
//      error and logs nothing. A failure during a query rejects that query; whether a line is
//      logged for that connection afterwards is not specified (pg reports the socket end after
//      the query error, racing the release).
//    - Besides `db_pool_error` and `db_close_timeout` (below) this module logs nothing.
//
// 6. Close — `handles.close()`
//    - From the moment of the first call no query, transaction or connection request of either
//      handle gets a connection: each rejects with DbError('closed'). This holds for requests
//      made after the call but before it resolved, and also when no query ever ran (Kysely's own
//      destroy() does nothing then, and a later query would open a new connection). No new
//      connection is opened after the call.
//    - Idle connections are closed at once. A connection in use (a running query, an open
//      transaction) is closed when it is given back: a query that holds a connection when
//      close() is called completes normally, and close() waits for it.
//    - When connections are still in use `closeTimeoutMs` after the call: one line per pool that
//      still has some (db first, then dbRead), level warn, message `db_close_timeout`, fields
//      exactly `{ pool, busy }` (busy = that pool's connections still in use, ≥ 1). Then those
//      connections are closed from the client side (pg `client.end()`: their queries reject with
//      the driver's error, PostgreSQL rolls their transactions back; no `db_pool_error` line) and
//      close() resolves without waiting for the code that held them.
//    - Resolves with undefined once every connection of both pools is closed or force-closed;
//      never rejects. Its timer is cleared when the pools end in time (nothing keeps the process
//      alive). A second or concurrent call never throws, resolves together with the first (at
//      once when already closed) and never ends a pool twice (pg-pool rejects a second end()).
//
// 7. Errors — `DbError` (below): name 'DbError', `code`, the fixed message of the code; own
//    properties exactly stack, message, name and code; no `cause`.
//
// 8. Wiring (implementation of this task; outside what the rule tests can import, covered by the
//    implementer's unit tests and smoke-entries):
//    - platform/config: AppConfig keeps no connection URL (drop `databaseUrl` / `redisUrl`);
//      util.inspect and JSON of what `loadConfig(env)` returns show no password (a rule test
//      calls it with the three variables set; keep that signature and keep accepting them).
//      DATABASE_URL, DATABASE_READ_URL and REDIS_URL are read by `loadConnectionConfig`, which is
//      part of configuration loading (apps/api AGENTS rule 6) and may live in platform/config as
//      long as this file exports it (待编排会话确认).
//    - entry.ts `runEntry`: the problems of loadConfig followed by those of loadConnectionConfig
//      go into one `config_invalid` line; exit code 1; no handle is created.
//    - PlatformModule: provides the handles as tokens `DB` (every entry) and `DB_READ` (admin only;
//      only the admin reports module may inject it, ADR-0001 §4.2 #11 — a dependency-cruiser rule
//      for that is a later gate change). Shutdown: HTTP entries close the HTTP server first (Nest
//      dispose), then the handles in `onApplicationShutdown` (not onModuleDestroy or
//      beforeApplicationShutdown, which run before the server stops); worker and payout close
//      them when their context closes. A startup failure after the handles exist closes them.
//    - smoke-entries: give each entry the variables it requires (URLs without a password, to a
//      local port nothing listens on); every entry still starts and exits 0. Also check that an
//      entry missing one required variable exits 1 with one `config_invalid` line.
//    - Not in this task: the start-up self-check that connections bypass PgBouncer (ADR-0002 §5,
//      method decided on staging, §10 #4); readiness probes (need a contract first); TLS
//      parameters of the URLs (`sslmode`, …) are passed to pg as given.
//
// 9. Rules for the implementation
//    - This directory is compiled by the `test` project too (erasableSyntaxOnly, no decorators)
//      and is loaded by plain `node --conditions=couli-src` in a child process of the rule tests
//      (type stripping): erasable syntax only (no parameter properties, enum, namespace,
//      decorators), no NestJS, `import type` for type-only imports, relative imports with `.ts`.
//      Runtime imports only: `node:*`, `kysely`, `pg`, `@couli/db`, `../config/index.ts` and
//      files of this directory; `../entries.ts` and `../logging/logger.ts` type-only.
//    - No `process.env`; no wall clock (a timer for the close timeout is fine); logs only through
//      `options.logger`.
import { inspect } from 'node:util';
import { createDb, type DB } from '@couli/db';
import pg from 'pg';
import { ConfigError } from '../config/index.ts';
import type { Kysely } from 'kysely';
import type { EntryName } from '../entries.ts';
import type { RootLogger } from '../logging/logger.ts';

/** Pool sizes per entry (ADR-0001 §4.2 #11); `dbRead` is null where the entry has no dbRead. */
export const POOL_SIZES: Readonly<
  Record<EntryName, Readonly<{ db: number; dbRead: number | null }>>
> = Object.freeze({
  api: Object.freeze({ db: 10, dbRead: null }),
  stream: Object.freeze({ db: 5, dbRead: null }),
  admin: Object.freeze({ db: 3, dbRead: 5 }),
  worker: Object.freeze({ db: 10, dbRead: null }),
  payout: Object.freeze({ db: 3, dbRead: null }),
});

/** A connection URL whose password never shows (section 3). Created by loadConnectionConfig. */
export class ConnectionUrl {
  #url: URL;
  /** For this module only: `href` is a URL loadConnectionConfig has validated. */
  constructor(href: string) {
    this.#url = new URL(href);
    Object.freeze(this);
  }

  /** The URL without password, query string or fragment. */
  get redacted(): string {
    const url = this.#url;
    const auth = `${url.username}${url.password ? ':***' : ''}${url.username || url.password ? '@' : ''}`;
    return `${url.protocol}//${auth}${url.host}${url.pathname}`;
  }

  /** The full URL (`new URL(value).href`), for the driver or client that connects. */
  reveal(): string {
    return this.#url.href;
  }

  toString(): string {
    return this.redacted;
  }

  toJSON(): string {
    return this.redacted;
  }

  [inspect.custom](): string {
    return `ConnectionUrl(${this.redacted})`;
  }
}

export type DbHandleName = 'db' | 'dbRead';

/** One pool of an entry (section 1). */
export interface DbPoolConfig {
  readonly name: DbHandleName;
  readonly url: ConnectionUrl;
  readonly max: number;
  readonly applicationName: string;
  readonly readOnly: boolean;
}

/** Connection settings of one entry (section 1). */
export interface ConnectionConfig {
  readonly entry: EntryName;
  readonly db: DbPoolConfig;
  readonly dbRead: DbPoolConfig | null;
  readonly redisUrl: ConnectionUrl | null;
}

/**
 * Reads DATABASE_URL, DATABASE_READ_URL and REDIS_URL for `entry` from `env` (section 1).
 * Throws the `ConfigError` of platform/config listing every problem.
 */
export function loadConnectionConfig(
  entry: EntryName,
  env: Readonly<Record<string, string | undefined>>,
): ConnectionConfig {
  const problems: string[] = [];
  const read = (name: 'DATABASE_URL' | 'DATABASE_READ_URL' | 'REDIS_URL'): ConnectionUrl | null => {
    const value = env[name];
    if (value === undefined || value === '') {
      problems.push(`${name}: must be set for the ${entry} entry`);
      return null;
    }
    const redis = name === 'REDIS_URL';
    try {
      const url = new URL(value);
      const valid = redis
        ? ['redis:', 'rediss:'].includes(url.protocol) && url.hostname !== ''
        : ['postgres:', 'postgresql:'].includes(url.protocol) &&
          url.username !== '' &&
          url.hostname !== '' &&
          url.pathname.length > 1;
      if (valid) return new ConnectionUrl(url.href);
    } catch {
      // Never propagate URL's error: it includes the unredacted input.
    }
    problems.push(
      `${name}: ${
        redis
          ? 'must be a redis:// or rediss:// URL with a host'
          : 'must be a postgres:// or postgresql:// URL with a user, a host and a database name'
      }`,
    );
    return null;
  };
  const primary = read('DATABASE_URL');
  const replica = entry === 'admin' ? read('DATABASE_READ_URL') : null;
  const redisUrl = entry === 'payout' ? null : read('REDIS_URL');
  if (problems.length > 0) throw new ConfigError(problems);
  return Object.freeze({
    entry,
    db: Object.freeze({
      name: 'db',
      url: primary as ConnectionUrl,
      max: POOL_SIZES[entry].db,
      applicationName: `couli-${entry}`,
      readOnly: false,
    }),
    dbRead:
      replica === null
        ? null
        : Object.freeze({
            name: 'dbRead',
            url: replica,
            max: POOL_SIZES.admin.dbRead as number,
            applicationName: 'couli-admin-read',
            readOnly: true,
          }),
    redisUrl,
  });
}

export type DbErrorCode = 'closed' | 'invalid_option';

const DB_ERROR_MESSAGES: Readonly<Record<DbErrorCode, string>> = {
  closed: 'database handles are closed',
  invalid_option: 'closeTimeoutMs must be an integer from 1 to 60000',
};

/** Thrown or rejected by this module (section 7). */
export class DbError extends Error {
  readonly code: DbErrorCode;

  constructor(code: DbErrorCode) {
    super(DB_ERROR_MESSAGES[code]);
    this.name = 'DbError';
    this.code = code;
  }
}

export interface DbHandlesOptions {
  /** Receives `db_pool_error` and `db_close_timeout` lines (section 5, 6). */
  readonly logger: RootLogger;
  /** How long close() waits for connections in use. Integer 1..60000; default 5000. */
  readonly closeTimeoutMs?: number;
}

export interface DbHandles {
  /** Primary database (read-write), schema `app`. */
  readonly db: Kysely<DB>;
  /** Read-only database for the admin reports; null in every other entry. */
  readonly dbRead: Kysely<DB> | null;
  /** Ends both pools (section 6). Idempotent; never rejects. */
  close(): Promise<void>;
}

/** Creates the pools of `config.entry` without connecting (section 4). */
export function createDbHandles(config: ConnectionConfig, options: DbHandlesOptions): DbHandles {
  const timeout = options.closeTimeoutMs === undefined ? 5000 : options.closeTimeoutMs;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) {
    throw new DbError('invalid_option');
  }
  let closing = false;
  let closed: Promise<void> | undefined;
  const pools: ManagedPool[] = [];
  const make = (settings: DbPoolConfig): Kysely<DB> => {
    const url = new URL(settings.url.reveal());
    if (settings.readOnly) {
      // pg gives URL options precedence over pool options. The last startup setting wins
      // and becomes the RESET / DISCARD default, unlike a session-level SET alone.
      const original = url.searchParams.getAll('options').at(-1) ?? '';
      // Two spaces keep the separator intact even if the original ends in a backslash.
      url.searchParams.set('options', `${original}  -c default_transaction_read_only=on`);
    }
    return createDb({
      connectionString: url.href,
      max: settings.max,
      applicationName: settings.applicationName,
      poolFactory(poolConfig) {
        const managed = managePool(poolConfig, settings, options.logger, () => closing);
        pools.push(managed);
        return managed.adapter;
      },
    });
  };
  const db = make(config.db);
  const dbRead = config.dbRead === null ? null : make(config.dbRead);
  return Object.freeze({
    db,
    dbRead,
    close(): Promise<void> {
      if (closed !== undefined) return closed;
      closing = true;
      // End pools directly: Kysely.destroy() does nothing before the first query, and
      // replaces our stable closed error with its own destroyed-driver error later.
      closed = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          void Promise.allSettled(pools.map((pool) => pool.forceClose())).then(() => resolve());
        }, timeout);
        void Promise.allSettled(pools.map((pool) => pool.end())).then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      return closed;
    },
  });
}

interface ManagedPool {
  readonly adapter: import('kysely').PostgresPool;
  end(): Promise<void>;
  forceClose(): Promise<void>;
}

/** Keeps pg objects private and owns all lifecycle handling outside Kysely. */
function managePool(
  config: pg.PoolConfig,
  settings: DbPoolConfig,
  logger: RootLogger,
  isClosing: () => boolean,
): ManagedPool {
  const clients = new Set<pg.Client>();
  const socketEnds = new Map<pg.Client, Promise<void>>();
  const ready = new WeakSet<pg.Client>();
  const failed = new WeakSet<pg.Client>();
  const leases = new Map<pg.Client, (destroy?: boolean) => void>();
  const borrowed = new Set<pg.Client>();
  const pending = new Set<(error: Error) => void>();
  let forcing = false;
  let ending: Promise<void> | undefined;
  const reportError = (error: unknown, client: pg.Client): void => {
    if (!ready.has(client) || failed.has(client) || forcing) return;
    failed.add(client);
    const code = (error as { code?: unknown } | null)?.code;
    logger.error(
      { pool: settings.name, code: typeof code === 'string' ? code : null },
      'db_pool_error',
    );
    // A dead checked-out session must not occupy a slot while application code waits.
    leases.get(client)?.(true);
  };
  class TrackedClient extends pg.Client {
    constructor(clientConfig?: pg.ClientConfig) {
      super(clientConfig);
      clients.add(this);
      this.on('error', (error: Error) => reportError(error, this));
      socketEnds.set(
        this,
        new Promise<void>((resolve) => {
          this.once('end', () => {
            clients.delete(this);
            socketEnds.delete(this);
            resolve();
          });
        }),
      );
    }
  }
  const pool = new pg.Pool({ ...config, keepAlive: true, Client: TrackedClient });
  pool.on('connect', (client) => ready.add(client));
  pool.on('error', reportError);
  const initialized = new WeakSet<pg.Client>();
  const end = (): Promise<void> => {
    if (ending !== undefined) return ending;
    for (const reject of pending) reject(new DbError('closed'));
    pending.clear();
    // pg-pool removes idle clients from its count before their sockets finish closing.
    ending = pool.end().then(async () => {
      await Promise.allSettled(socketEnds.values());
    });
    return ending;
  };
  return {
    adapter: {
      // No raw options or control client capable of bypassing the lifecycle gate.
      options: {},
      connect() {
        if (isClosing() || ending !== undefined) return Promise.reject(new DbError('closed'));
        return new Promise<pg.PoolClient>((resolve, reject) => {
          pending.add(reject);
          pool.connect((error, client) => {
            if (error || client === undefined) {
              pending.delete(reject);
              reject(error ?? new DbError('closed'));
              return;
            }
            const release = client.release.bind(client);
            let released = false;
            client.release = (destroy?: boolean | Error) => {
              if (released) return;
              released = true;
              leases.delete(client);
              borrowed.delete(client);
              release(destroy || failed.has(client));
            };
            leases.set(client, client.release);
            if (isClosing() || ending !== undefined) {
              pending.delete(reject);
              client.release(true);
              reject(new DbError('closed'));
              return;
            }
            // SET overrides URL options while preserving TLS and other URL settings.
            // Initialize here so a failed SET releases its lease (Kysely's hook does not).
            const initialize = initialized.has(client)
              ? Promise.resolve()
              : client
                  .query(
                    "SELECT set_config('application_name', $1, false), set_config('default_transaction_read_only', $2, false)",
                    [settings.applicationName, settings.readOnly ? 'on' : 'off'],
                  )
                  .then(() => {
                    initialized.add(client);
                  });
            void initialize.then(
              () => {
                pending.delete(reject);
                if (isClosing() || ending !== undefined) {
                  client.release(true);
                  reject(new DbError('closed'));
                } else {
                  borrowed.add(client);
                  resolve(client);
                }
              },
              (error: unknown) => {
                pending.delete(reject);
                client.release(true);
                reject(error);
              },
            );
          });
        });
      },
      end,
    },
    end,
    forceClose() {
      // Connecting and initializing clients have not been handed to a caller yet.
      const busy = borrowed.size;
      if (busy > 0) logger.warn({ pool: settings.name, busy }, 'db_close_timeout');
      forcing = true;
      // end() can wait for the peer's FIN forever, including during connection setup.
      // Destroy every live socket locally; neither end() nor socket 'end' is awaited.
      for (const client of clients) {
        client.connection.stream.destroy();
        leases.get(client)?.(true);
      }
      return Promise.resolve();
    },
  };
}
