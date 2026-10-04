// Partition maintenance of the worker (ADR-0001 §4.2 第 4 项 分区维护, 第 5 项 分区粒度, 第 8 项
// couli_maint, 第 16 项 event_log 留存 ≥190 天; 规划/02 §15.1 PG 一行; BR-ID-30 ⑫、⑯、⑰ (功能对照
// G-14)). Task B1-01j implements everything below in two steps (规划/11 §2.3, db/AGENTS.md): first the
// migration (section A), then — after the orchestrator has run the migration and `pnpm db:snapshot`
// outside the sandbox — this module (sections B–H). The rule tests in test/spec/db/partitions/** and
// test/spec/platform/maintenance/** import this file by path and call the SQL functions by name; the
// names, signatures and semantics written here are the contract. Values that no document fixes are
// marked 待编排会话确认 (suggested defaults).
//
// A. Migration — `db/migrations/0008_<kebab-name>.sql` (next free number; 0007 is the newest on main)
//    Rules of db/AGENTS.md apply: first line `-- Up Migration`, no down section, recovery in the header
//    comment, no date-dependent DDL (the migration creates no partition), grants in this migration,
//    `app.ensure_month_partition` is NOT redefined (its allow-list stays event_log, orders).
//    IMPORTANT: packages/db/src/migrations.test.ts reads the LAST text `IF p_table NOT IN (…) THEN` of
//    all migrations as the allow-list of ensure_month_partition; the new functions must not contain
//    that text (use `= ANY (ARRAY[…])` or CASE).
//    Both functions: LANGUAGE plpgsql, SECURITY DEFINER, `SET search_path = pg_catalog, pg_temp`,
//    owned by couli_migrator (the role that runs migrations; a non-owner cannot drop partitions,
//    ADR-0001 §4.2 #4), `REVOKE ALL … FROM PUBLIC`, `GRANT EXECUTE … TO couli_maint` and to no other
//    role: their ACL is exactly {couli_maint=X/couli_migrator, couli_migrator=X/couli_migrator}.
//    Errors are raised with exactly the SQLSTATE and message given here (`%` = the argument).
//
//    A1. `app.drop_expired_month_partitions(p_table text, p_now timestamptz) RETURNS text[]`
//        Drops the month partitions of `app.<p_table>` whose whole range is past the retention period
//        and returns their names. Checks, in this order:
//          a. p_table or p_now NULL → 22004 null_value_not_allowed
//             `drop_expired_month_partitions: p_table and p_now are required`
//          b. p_now is ±infinity → 22023 invalid_parameter_value
//             `drop_expired_month_partitions: p_now must be finite`
//          c. p_table is exactly (case-sensitive, no trimming) one of the RETAINED tables below →
//             55000 object_not_in_prerequisite_state
//             `drop_expired_month_partitions: partitions of app.% are kept until their retention period is confirmed`
//             — whether or not the table exists yet (most of them do not).
//          d. p_table is not exactly a key of the RETENTION table below → 22023 invalid_parameter_value
//             `drop_expired_month_partitions: table "%" has no partition retention rule`
//             (any other name: link_logs, a partition name, 'EVENT_LOG', ' event_log', 'app.event_log', '').
//          e. app.<p_table> is not a partitioned table → 42P01 undefined_table
//             `drop_expired_month_partitions: app.% is not a partitioned table`
//        RETAINED (BR-ID-30 ⑫ 账务记录, ⑰ 订单类记录 — "确认前不设自动删除任务，也不删除这些表的分区";
//        ⑧ audit_logs "确认前不设自动删除任务"; 规划/02 §15.1 "保管期限确认前分区维护任务不得对它们执行
//        删除"): orders, order_keys, order_status_history, order_rights, order_settlements,
//        commission_splits, settle_bills, settle_batches, settle_batch_items, settle_adjustments,
//        claims, claim_items, ledger_vouchers, ledger_entries, withdrawals, payout_attempts, audit_logs.
//        (⑰'s "金额版本与受益人事件" tables have no names yet: they fall under d, also refused.)
//        RETENTION (days): event_log 190 (ADR-0001 §4.2 #16 "留存 ≥190 天"; BR-ID-30 ⑯ "190 天").
//        Nothing else is droppable in this task: link_logs (day partitions, BR-ID-30 ② 90 天) gets its
//        day-partition maintenance in a later task (0006 header), until then it falls under d.
//        Cutoff (BR-ID-30: "删除条件为 created_at < 运行当日 00:00（+08:00）− 留存天数"): let D be the
//        calendar date of p_now at UTC+08:00 (fixed offset; the session TimeZone changes nothing);
//        cutoff = 00:00 of (D − retention days) at +08:00. A partition is dropped exactly when BOTH
//          (i)  ALL rows it can hold by its partition key are older than the cutoff: its upper bound
//               (the first instant of the next UTC month of `occurred_at`) ≤ cutoff, AND
//          (ii) no row in it has `created_at` ≥ cutoff (BR-ID-30 judges by created_at; occurred_at,
//               the partition key, can be earlier than created_at for an event recorded late).
//        A partition that passes (i) but not (ii) is kept (whole; rows are never deleted one by one)
//        and not reported; a later call drops it once its NEWEST created_at is older than the cutoff
//        (one row at or after the cutoff keeps the whole partition, whatever the other rows are).
//        Example: event_log_p202603 ([2026-03-01Z, 2026-04-01Z)) holding only rows created in March is
//        kept for any p_now ≤ 2026-10-08T15:59:59.999Z and dropped from p_now = 2026-10-08T16:00:00Z
//        (= 2026-10-09 00:00 +08:00, cutoff 2026-04-02 00:00 +08:00) on. If it also holds a row with
//        created_at 2026-10-08T16:00:00Z, it is kept up to p_now 2027-04-17T15:59:59.999Z (cutoff
//        2026-10-09 00:00 +08:00 equals that created_at: not older) and dropped from
//        2027-04-17T16:00:00Z on.
//        Only children of app.<p_table> named exactly `<p_table>_pYYYYMM` (the partitions
//        app.ensure_month_partition creates) are considered; the DEFAULT partition and any other child
//        are never dropped. Dropping is `DROP TABLE` of the partition (DDL; the append-only trigger of
//        event_log does not fire), in the same transaction as the call.
//        Result: the dropped names in ascending order; '{}' (never NULL) when nothing was dropped.
//        Concurrency: two sessions calling it at the same time for the same table must both succeed
//        and every partition is dropped and reported exactly once (e.g. a transaction-level advisory
//        lock per table taken before listing the partitions, and the per-partition lock key that
//        ensure_month_partition uses, `'app.ensure_month_partition:' || <partition name>`).
//        Concurrent writers (BR-ID-30 created_at rule must hold against them): for a partition that
//        passes (i), the function FIRST takes `LOCK TABLE app.<partition> IN ACCESS EXCLUSIVE MODE`
//        (waiting for transactions that are writing into it to end), THEN checks (ii) under that lock
//        with a statement that starts after the lock was granted, and drops only if (ii) still holds.
//        So a row inserted by a transaction that commits while the call waits is seen and keeps the
//        partition; checking first and locking only for the DROP is wrong (it loses that row).
//
//    A2. `app.partition_default_rows() RETURNS TABLE (table_name text, default_partition text, row_count bigint)`
//        One row for every partitioned table of schema `app` that has a DEFAULT partition (read from
//        pg_partitioned_table, so tables added later are covered without a new migration), ordered by
//        table_name (COLLATE "C"): the table, its DEFAULT partition, and the exact number of rows in
//        that DEFAULT partition. Rows there mean a partition was missing (ADR-0001 §4.2 #4 "其中有数据即
//        告警"). Today: event_log, link_logs, orders. Note: link_logs has no day partitions yet, so every
//        link_logs row sits in its DEFAULT partition and is reported (待编排会话确认: suggested default —
//        report it; the day-partition task removes the cause).
//
// B. Module API (this file) — `createPartitionMaintenance(options)` → `PartitionMaintenance`
//    options: a plain object with exactly these keys —
//      db          REQUIRED. A Kysely handle whose sessions are the role couli_maint (ADR-0001 §4.2
//                  #4, #8). Accepted when it is a non-null object; the role is checked by runOnce.
//      logger      REQUIRED. A RootLogger (an object with functions info, warn and error).
//      clock       REQUIRED. The process Clock (an object with a function now).
//      intervalMs  optional integer 100..86 400 000; default MAINTENANCE_INTERVAL_MS (3 600 000, one
//                  hour; 待编排会话确认 — see section F).
//    Anything else (missing required key, unknown key, wrong type, intervalMs out of range, a fraction,
//    NaN, a string) → throws MaintenanceError('invalid_option') synchronously. Opens no connection,
//    reads no time, logs nothing.
//
// C. `runOnce()` → Promise<MaintenanceReport> — one maintenance run, in this order:
//    1. Role: `SELECT current_user`. Unless it is exactly 'couli_maint', rejects
//       MaintenanceError('wrong_role') having done nothing else (no function called, no log line).
//    2. Time: reads `clock.now()` exactly once; that instant (`now`) is used by every step below. No
//       other time source (no Date.now(), new Date() without argument, performance.now(), SQL now()).
//    3. Pre-create (ADR-0001 §4.2 #4 "按月的表预建未来 3 个月"): for each table of
//       MONTH_PARTITIONED_TABLES (@couli/db, in that order: event_log, orders) and each month of
//       monthsToEnsure(now, MONTHS_AHEAD) (UTC months: the month of `now` and the 3 following, in
//       ascending order): `SELECT app.ensure_month_partition(<table>, '<YYYY-MM-01>'::date)` as its
//       own statement. A success appends the returned name to `ensured`; a failure (e.g. 23514 when
//       the DEFAULT partition holds rows of that month) logs `partition_ensure_failed`, counts in
//       `failed`, and the run continues with the next month / table.
//    4. Drop (ADR-0001 §4.2 #4 "建和删分区"; BR-ID-30 ⑯ and "由每日 04:00（+08:00）删除任务…执行"):
//       ONLY when the time of day of `now` at UTC+08:00 is 04:00:00.000 or later (so between 00:00 and
//       03:59:59.999 +08:00 this step is skipped entirely: no call, no log line, `dropped` empty).
//       Pre-creation (3) and the DEFAULT check (5) run in every run; deletion is a daily step whose
//       first chance each day is the first run at or after 04:00 +08:00 (with the hourly schedule:
//       between 04:00 and 05:00). Later runs of the same day call the function again; it is idempotent
//       and normally drops nothing more ("同一日只删一次" holds by result).
//       For each table of DROPPABLE_TABLES (exactly ['event_log']; never a RETAINED table)
//       `SELECT app.drop_expired_month_partitions(<table>, <now>)`; each returned name is appended to
//       `dropped` and logged `partition_dropped`; a failure logs `partition_drop_failed` and counts in
//       `failed`. Example: with event_log_p202602 and p202603 (rows created in their months), a run at
//       2026-10-09 03:59:59.999 +08:00 drops nothing; a run at 2026-10-09 04:00:00.000 +08:00 drops both.
//    5. DEFAULT check: `SELECT * FROM app.partition_default_rows()`; every row with row_count > 0 is
//       appended to `defaultRows` and logged `partition_default_has_rows` (one line per table per run,
//       so the alert repeats every run while the rows stay). A failure logs
//       `partition_default_check_failed` and counts in `failed`.
//    6. Logs `partition_maintenance_done` and resolves with the report.
//    Any rejection other than wrong_role (e.g. the database cannot be reached at step 1) is passed on
//    unchanged by runOnce (start() logs it, section D). runOnce may be called at any time, also
//    without start() and after stop().
//    MaintenanceReport: a plain object with exactly
//      ensured      string[]  names returned by ensure_month_partition, in call order
//      dropped      string[]  names returned by drop_expired_month_partitions, in call order
//      defaultRows  { table, partition, rows }[]  rows: a JS number (safe integer), only rows > 0,
//                   ordered by table as the function returns them
//      failed       number    failed statements of steps 3–5
//
// D. Schedule — `start()`, `stop()`
//    The queue contract (platform/queue §5.3: "No cron schedules yet (schedule:false)") offers no
//    scheduled jobs, so this module schedules itself with timers (待编排会话确认 — suggested default):
//    - start(): rejects MaintenanceError('already_started') when called before. Otherwise performs the
//      first run at once and resolves after it settled: when that run rejects wrong_role, start()
//      rejects with that MaintenanceError and nothing is scheduled; when it rejects with anything
//      else, logs `partition_maintenance_failed` and resolves. From then on a run starts intervalMs
//      after the previous one settled (never two runs of one instance at once); a rejected scheduled
//      run logs `partition_maintenance_failed` and the schedule goes on.
//    - stop(): from the first call no further run starts; awaits the run of this schedule that is in
//      progress (also the first run inside start(): start() then settles as above after that run, and
//      nothing is scheduled) and resolves only after that run has settled — so the caller may close
//      the db handle right after; resolves with undefined, never rejects; a second or concurrent call
//      resolves together with the first; also before start() (then start() afterwards rejects
//      already_started). Runs started by calling runOnce() directly are not awaited.
//    - Several worker processes may run the schedule at the same time: the SQL functions are
//      idempotent and serialised by advisory locks, so concurrent runs create and drop each partition
//      once and report no failure.
//
// E. Log lines — only through `options.logger` itself (no child logger, no extra bindings), message =
//    the event name, fields exactly as listed (flat; no error object, message, stack, SQL text,
//    connection parameters or row contents — the DEFAULT rows can carry personal data):
//      partition_ensure_failed        error  { table, month, sqlstate }  month 'YYYY-MM-01'
//      partition_dropped              info   { table, partition }
//      partition_drop_failed          error  { table, sqlstate }
//      partition_default_has_rows     warn   { table, partition, rows }  rows a number
//      partition_default_check_failed error  { sqlstate }
//      partition_maintenance_done     info   { ensured, dropped, failed }  the three counts
//      partition_maintenance_failed   error  { sqlstate }
//    sqlstate: the error's `code` when it is a string of five characters [0-9A-Z], else null.
//
// F. Open points (待编排会话确认, suggested defaults written above):
//    - Scheduling without pg-boss cron (D). Hourly runs pre-create and check DEFAULT partitions;
//      deletion waits for 04:00 +08:00 each day (C.4, BR-ID-30 每日 04:00 删除任务), so it happens at
//      most one interval after 04:00.
//    - Retention of event_log by partition bound AND created_at (A1 (i), (ii)): BR-ID-30 names
//      created_at, the partitions follow occurred_at; a partition goes only when both say so.
//    - Wiring is outside this task's paths: the worker entry (apps/api/src/entry.ts) and a couli_maint
//      connection variable (platform/config, platform/db) — a follow-up task starts the schedule in the
//      worker entry and stops it before the queue on SIGTERM.
//    - DEFAULT check over every partitioned table of app, link_logs included (A2).
//
// G. Errors — `MaintenanceError`: name 'MaintenanceError', `code`, the fixed message of
//    MAINTENANCE_ERROR_MESSAGES; own properties exactly stack, message, name and code; no `cause`.
//
// H. Rules for the implementation
//    - This directory is compiled by the `test` project too (erasableSyntaxOnly, no decorators):
//      erasable syntax only, no NestJS, `import type` for type-only imports, relative imports with
//      `.ts`. Runtime imports only: `node:*`, `kysely`, `@couli/db` and files of this directory;
//      `../clock/clock.ts` and `../logging/logger.ts` type-only. No pg-boss.
//    - No `process.env`; no wall clock (section C.2); logs only through `options.logger`.
//    - Implementation-side unit tests go next to the code (`*.test.ts`, no database).
import {
  MONTH_PARTITIONED_TABLES,
  MONTHS_AHEAD,
  monthStartDate,
  monthsToEnsure,
  type DB,
} from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { Clock } from '../clock/clock.ts';
import type { RootLogger } from '../logging/logger.ts';

/** Default interval between two runs of one instance (section B, D). */
export const MAINTENANCE_INTERVAL_MS = 3_600_000;

/** Tables whose expired partitions the run drops (section C.4). */
export const DROPPABLE_TABLES: readonly string[] = Object.freeze(['event_log']);

export interface PartitionMaintenanceOptions {
  readonly db: Kysely<DB>;
  readonly logger: RootLogger;
  readonly clock: Clock;
  readonly intervalMs?: number;
}

export interface DefaultRows {
  readonly table: string;
  readonly partition: string;
  readonly rows: number;
}

export interface MaintenanceReport {
  readonly ensured: readonly string[];
  readonly dropped: readonly string[];
  readonly defaultRows: readonly DefaultRows[];
  readonly failed: number;
}

export interface PartitionMaintenance {
  runOnce(): Promise<MaintenanceReport>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type MaintenanceErrorCode = 'invalid_option' | 'wrong_role' | 'already_started';

/** The fixed message of each code (section G). */
export const MAINTENANCE_ERROR_MESSAGES: Readonly<Record<MaintenanceErrorCode, string>> =
  Object.freeze({
    invalid_option: 'invalid partition maintenance option',
    wrong_role: 'partition maintenance must run as couli_maint',
    already_started: 'partition maintenance has already been started',
  });

export class MaintenanceError extends Error {
  readonly code: MaintenanceErrorCode;

  constructor(code: MaintenanceErrorCode) {
    super(MAINTENANCE_ERROR_MESSAGES[code]);
    this.name = 'MaintenanceError';
    this.code = code;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function validateOptions(options: unknown): asserts options is PartitionMaintenanceOptions {
  if (!isObject(options) || Object.getPrototypeOf(options) !== Object.prototype) {
    throw new MaintenanceError('invalid_option');
  }
  const allowed = new Set<PropertyKey>(['db', 'logger', 'clock', 'intervalMs']);
  const logger = options['logger'];
  if (
    Reflect.ownKeys(options).some((key) => !allowed.has(key)) ||
    !['db', 'logger', 'clock'].every((key) => Object.hasOwn(options, key)) ||
    !isObject(options['db']) ||
    !isObject(logger) ||
    !['info', 'warn', 'error'].every((key) => typeof logger[key] === 'function') ||
    !isObject(options['clock']) ||
    typeof options['clock']['now'] !== 'function' ||
    (Object.hasOwn(options, 'intervalMs') &&
      (typeof options['intervalMs'] !== 'number' ||
        !Number.isInteger(options['intervalMs']) ||
        options['intervalMs'] < 100 ||
        options['intervalMs'] > 86_400_000))
  ) {
    throw new MaintenanceError('invalid_option');
  }
}

function sqlstate(error: unknown): string | null {
  return isObject(error) && typeof error['code'] === 'string' && /^[0-9A-Z]{5}$/.test(error['code'])
    ? error['code']
    : null;
}

export function createPartitionMaintenance(
  options: PartitionMaintenanceOptions,
): PartitionMaintenance {
  validateOptions(options);
  const { db, logger, clock, intervalMs = MAINTENANCE_INTERVAL_MS } = options;
  let started = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let scheduled: Promise<void> | undefined;

  async function runOnce(): Promise<MaintenanceReport> {
    const role = await sql<{ role: string }>`SELECT current_user AS role`.execute(db);
    if (role.rows[0]?.role !== 'couli_maint') throw new MaintenanceError('wrong_role');

    const now = clock.now();
    const months = monthsToEnsure(now, MONTHS_AHEAD).map(monthStartDate);
    const ensured: string[] = [];
    const dropped: string[] = [];
    const defaultRows: DefaultRows[] = [];
    let failed = 0;

    // Separate autocommit statements keep one failed month from aborting the whole run.
    for (const table of MONTH_PARTITIONED_TABLES) {
      for (const month of months) {
        try {
          const result = await sql<{ partition: string }>`
            SELECT app.ensure_month_partition(${table}, ${month}::date) AS partition
          `.execute(db);
          ensured.push(result.rows[0]!.partition);
        } catch (error) {
          failed += 1;
          logger.error({ table, month, sqlstate: sqlstate(error) }, 'partition_ensure_failed');
        }
      }
    }

    // Fixed +08:00 hour, independent of the host/session timezone. SQL owns retention checks.
    if ((now.getUTCHours() + 8) % 24 >= 4) {
      for (const table of DROPPABLE_TABLES) {
        try {
          const result = await sql<{ partitions: string[] }>`
            SELECT app.drop_expired_month_partitions(${table}, ${now}::timestamptz) AS partitions
          `.execute(db);
          for (const partition of result.rows[0]!.partitions) {
            dropped.push(partition);
            logger.info({ table, partition }, 'partition_dropped');
          }
        } catch (error) {
          failed += 1;
          logger.error({ table, sqlstate: sqlstate(error) }, 'partition_drop_failed');
        }
      }
    }

    try {
      const result = await sql<{
        table_name: string;
        default_partition: string;
        row_count: bigint;
      }>`SELECT * FROM app.partition_default_rows()`.execute(db);
      for (const row of result.rows) {
        // The report explicitly uses numbers; never silently round a PG bigint count.
        const rows = Number(row.row_count);
        if (!Number.isSafeInteger(rows) || rows < 0) {
          throw new RangeError('partition row count is not a safe non-negative integer');
        }
        if (rows > 0) {
          const alert = { table: row.table_name, partition: row.default_partition, rows };
          defaultRows.push(alert);
          logger.warn(alert, 'partition_default_has_rows');
        }
      }
    } catch (error) {
      failed += 1;
      logger.error({ sqlstate: sqlstate(error) }, 'partition_default_check_failed');
    }

    logger.info(
      { ensured: ensured.length, dropped: dropped.length, failed },
      'partition_maintenance_done',
    );
    return { ensured, dropped, defaultRows, failed };
  }

  async function scheduledRun(first: boolean): Promise<void> {
    try {
      await runOnce();
    } catch (error) {
      if (first && error instanceof MaintenanceError && error.code === 'wrong_role') {
        stopped = true;
        throw error;
      }
      logger.error({ sqlstate: sqlstate(error) }, 'partition_maintenance_failed');
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          timer = undefined;
          scheduled = scheduledRun(false);
        }, intervalMs);
      }
    }
  }

  return {
    runOnce,
    async start() {
      if (started || stopped) throw new MaintenanceError('already_started');
      started = true;
      scheduled = scheduledRun(true);
      await scheduled;
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      // Includes the initial run, but deliberately excludes callers of runOnce().
      await scheduled?.catch(() => undefined);
    },
  };
}
