// Maintenance connection of the worker entry (task B1-01n): the variable DATABASE_MAINT_URL and its
// pool of one connection as couli_maint. Basis: ADR-0001 §4.2 第 4 项 (worker 里的定时任务以
// couli_maint 调用 SECURITY DEFINER 函数建和删分区), 第 8 项 (couli_maint 只有分区函数的 EXECUTE), 第 11
// 项 (每进程连接池，按数据库节点规格复核; 不用 PgBouncer); 规划/02 §15.1 PG 一行 (分区的预建与删除由
// worker 定时任务以专用角色执行), §3.1 (worker 组). The rule tests in test/spec/platform/db/maint-*.ts
// import this file by path; the names, signatures and semantics written here are the contract.
// Values that no document fixes are marked 待编排会话确认 (suggested defaults, decided by the
// orchestration session's brief for B1-01n unless noted).
//
// The contract of apps/api/src/modules/platform/db/index.ts (sections 1–7) and its addenda 1–3
// (test/spec/platform/db/connection-params.test.ts, connection-tls.test.ts,
// connection-hardening.test.ts) apply to DATABASE_MAINT_URL exactly as to DATABASE_URL, with the
// differences written here. `loadConnectionConfig`, `ConnectionConfig`, `POOL_SIZES`,
// `createDbHandles` and `DbHandles` do NOT change (their shapes are fixed by existing rule tests):
// the maintenance connection has its own loader, constants and handle below.
//
// 1. `loadMaintConnectionConfig(entry, env)` → `MaintConnectionConfig | null`
//    - entry is not 'worker' (api, stream, admin, payout): returns null without reading `env` at all
//      (no property of `env` is read), whatever DATABASE_MAINT_URL or APP_ENV hold.
//    - entry 'worker': reads exactly two names of `env` — APP_ENV and DATABASE_MAINT_URL — and
//      nothing else, never `process.env`; it never changes `env` (a frozen object works).
//      DATABASE_MAINT_URL set to '' counts as unset.
//        unset, APP_ENV exactly 'test'  → returns null (no maintenance pool; the worker runs
//                                          without partition maintenance and logs
//                                          `partition_maintenance_disabled`, see
//                                          platform/maintenance/worker.ts). 待编排会话确认.
//        unset, any other APP_ENV       → ConfigError, problems exactly
//          (local, staging, prod; also     [`DATABASE_MAINT_URL: must be set for the worker entry`]
//          unset / invalid APP_ENV —
//          fail closed)
//      A set value is checked in every APP_ENV (also 'test'), one problem at most, first match wins:
//        a. malformed (section 1 of db/index.ts and addendum 2 §2: WHATWG URL parser, protocol
//           postgres: or postgresql:, non-empty username, hostname and database name; no invalid
//           percent escape in user, password or database name)
//             `DATABASE_MAINT_URL: must be a postgres:// or postgresql:// URL with a user, a host and a database name`
//        b. query parameters outside the list of addendum 1 / addendum 2 §5 (literal names, each at
//           most once, sslmode values, sslrootcert with verify-ca (required) / verify-full)
//             `DATABASE_MAINT_URL: query parameters may only be sslmode (disable, require, verify-ca or verify-full), sslrootcert (required by verify-ca, allowed with verify-full), options, password or sslpassword, each at most once and with a literal name`
//        c. a control character in user, database name, user-info password, `password` query
//           value or options, after decoding (addendum 3 §2)
//             `DATABASE_MAINT_URL: connection fields may not contain control characters`
//        d. the percent-decoded user is not exactly 'couli_maint' (case-sensitive; ADR-0001 §4.2 #4,
//           #8 — the maintenance pool always runs as couli_maint; 待编排会话确认)
//             `DATABASE_MAINT_URL: must connect as couli_maint`
//        e. sslrootcert given but its file cannot be read as UTF-8 (addendum 2 §4)
//             `DATABASE_MAINT_URL: sslrootcert could not be read`
//      A problem → throws the ConfigError of platform/config with exactly that one-element
//      `problems` list (message as ConfigError builds it, no `cause`); no message contains any part
//      of the value.
//    - Success → a deeply frozen plain object whose own properties are exactly
//        name             'dbMaint'
//        url              a ConnectionUrl (db/index.ts section 3) of the value: `redacted` hides the
//                         password, `reveal()` is `new URL(value).href`
//        max              MAINT_POOL_SIZE (1)
//        applicationName  MAINT_APPLICATION_NAME ('couli-worker-maint')
//        readOnly         false
//
// 2. Pool size and name — `MAINT_POOL_SIZE` = 1 (one maintenance run at a time per process; the
//    schedule of platform/maintenance never runs two runs of one instance at once; reviewed
//    against the database node with the others, ADR-0001 §4.2 #11 "按数据库节点规格复核") and
//    `MAINT_APPLICATION_NAME` = 'couli-worker-maint' (makes the session visible in
//    pg_stat_activity). Only in these constants (and the rule tests).
//
// 3. Handle — `createMaintDbHandle(config, options)` → `MaintDbHandle`
//    - `options` as `createDbHandles` (db/index.ts section 4): `logger` (RootLogger) and
//      `closeTimeoutMs` (integer 1..60 000, default 5 000; anything else → DbError('invalid_option')
//      synchronously, nothing created).
//    - `config` must be the very object returned by `loadMaintConnectionConfig` (identity; a copy,
//      a look-alike with the same fields, null or anything else → DbError('invalid_option')
//      synchronously, nothing created).
//    - One pg pool: max = MAINT_POOL_SIZE, every session's application_name =
//      MAINT_APPLICATION_NAME, user couli_maint (from the URL), TCP keepalive on; connection fields
//      and TLS built explicitly from the URL exactly as for `db` (addenda 1–3: discrete fields,
//      never a connection string or a driver-parsed URL); sessions read-write
//      (default_transaction_read_only = off, as `db`). A Kysely instance bound to schema `app` with
//      int8 and int8[] parsed as BigInt (ADR-0001 §4.2 #3).
//    - Creating the handle opens no connection.
//    - Returns a frozen plain object whose own properties are exactly `db` (a plain Kysely
//      instance: prototype Kysely.prototype, no own properties) and `close`; util.inspect and JSON
//      of the handle and of the config show no password.
//    - Connection errors and close exactly as sections 5 and 6 of db/index.ts, with pool name
//      'dbMaint': `db_pool_error` { pool: 'dbMaint', code }, `db_close_timeout`
//      { pool: 'dbMaint', busy }; after the first close() call every query rejects with
//      DbError('closed'); close() resolves with undefined, never rejects, is idempotent. Besides
//      these two lines the handle logs nothing.
//
// 4. Rules for the implementation
//    - Same as section 9 of db/index.ts (erasable syntax only, no NestJS, `import type` for types,
//      relative imports with `.ts`, no `process.env`, no wall clock, logs only through
//      options.logger). The implementation may move the shared URL / pool code into index.ts or a
//      new file of this directory; this file must keep exporting the names below.
//    - Wiring (entry.ts, maintenance/worker.ts) is described in platform/maintenance/worker.ts.
import type { DB } from '@couli/db';
import { ConfigError } from '../config/index.ts';
import { DbError, loadDatabaseUrl, createManagedDbHandles } from './index.ts';
import type { Kysely } from 'kysely';
import type { EntryName } from '../entries.ts';
import type { ConnectionUrl, DbHandlesOptions } from './index.ts';

/** Pool size of the maintenance connection (section 2). */
export const MAINT_POOL_SIZE = 1;

/** application_name of every maintenance session (section 2). */
export const MAINT_APPLICATION_NAME = 'couli-worker-maint';

/** The maintenance pool of the worker entry (section 1). */
export interface MaintConnectionConfig {
  readonly name: 'dbMaint';
  readonly url: ConnectionUrl;
  readonly max: number;
  readonly applicationName: string;
  readonly readOnly: false;
}

/** The maintenance handle (section 3). */
export interface MaintDbHandle {
  /** couli_maint, schema `app`, at most MAINT_POOL_SIZE connections. */
  readonly db: Kysely<DB>;
  /** Ends the pool (db/index.ts section 6). Idempotent; never rejects. */
  close(): Promise<void>;
}

const validatedConfigs = new WeakSet<MaintConnectionConfig>();

/** Reads DATABASE_MAINT_URL for `entry` from `env` (section 1). */
export function loadMaintConnectionConfig(
  entry: EntryName,
  env: Readonly<Record<string, string | undefined>>,
): MaintConnectionConfig | null {
  if (entry !== 'worker') return null;
  const appEnv = env['APP_ENV'];
  const value = env['DATABASE_MAINT_URL'];
  if (value === undefined || value === '') {
    if (appEnv === 'test') return null;
    throw new ConfigError(['DATABASE_MAINT_URL: must be set for the worker entry']);
  }
  const config: MaintConnectionConfig = Object.freeze({
    name: 'dbMaint',
    url: loadDatabaseUrl(value, 'DATABASE_MAINT_URL', 'couli_maint'),
    max: MAINT_POOL_SIZE,
    applicationName: MAINT_APPLICATION_NAME,
    readOnly: false,
  });
  validatedConfigs.add(config);
  return config;
}

/** Creates the maintenance pool without connecting (section 3). */
export function createMaintDbHandle(
  config: MaintConnectionConfig,
  options: DbHandlesOptions,
): MaintDbHandle {
  if (!validatedConfigs.has(config)) throw new DbError('invalid_option');
  const handles = createManagedDbHandles(config, null, options);
  return Object.freeze({ db: handles.db, close: handles.close });
}
