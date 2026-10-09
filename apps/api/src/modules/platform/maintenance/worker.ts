// Partition maintenance in the worker entry (task B1-01n; follow-up named in section F of
// ./index.ts "Wiring is outside this task's paths"). Basis: ADR-0001 §4.2 第 4 项 (worker 里的定时任务
// 以 couli_maint 建和删分区; DEFAULT 分区有数据即告警), 第 8 项 (couli_maint), 第 11 项 (连接池), 第 20 项
// (payout 进程只读 PG 配置表、不做别的); 规划/02 §15.1 PG 一行 (分区的预建与删除由 worker 定时任务以专用
// 角色执行), §3.1 (worker 组跑 worker). The rule tests in test/spec/platform/maintenance/** import this
// file by path; the names, signatures and semantics written here are the contract. Values that no
// document fixes are marked 待编排会话确认 (suggested defaults).
//
// 1. Worker 契约 8 in test/spec/platform/maintenance/worker-day-partitions.int.test.ts supersedes
//    the former link_logs DEFAULT exemption: WORKER_QUIET_DEFAULT_TABLES is no longer exported;
//    every nonempty DEFAULT partition, including link_logs, produces a warn line.
//
// 2. `createWorkerMaintenance(options)` → PartitionMaintenance
//    = createPartitionMaintenance({ ...options, dayPartitions: true }) (worker 契约 8.2).
//    options: exactly the keys db, logger, clock (required) and intervalMs (optional) of section B of
//    ./index.ts, validated there; any other key (quietDefaultTables and dayPartitions included)
//    → MaintenanceError
//    ('invalid_option') synchronously. Opens no connection, reads no time, logs nothing.
//    Because dayPartitions is on, the worker also deletes expired link_open_attempts in the same
//    daily run as the link_logs day-partition drop (B1-01zk, section J of ./index.ts).
//
// 3. `startWorkerServices(parts)` → Promise<WorkerServices> — start and stop order of the worker
//    entry, testable without a process. parts (a plain object):
//      queue        { start(): Promise<void>; stop(): Promise<void> }   the QueueRuntime
//      maintenance  { start(); stop() } (a PartitionMaintenance) or null (no maintenance pool)
//      close        array of functions returning a promise: the resources to close, in this order
//                   (the entry passes: close the Nest context — it closes the db handles — then
//                   close the maintenance handle); may be empty
//      logger       RootLogger
//    Every step below is awaited before the next begins; no two steps run at the same time; each
//    function is called at most once per call of startWorkerServices (stop steps at most once in
//    total, see stop()).
//    Start:
//      1. queue.start().
//      2. maintenance null: logs exactly one line through `logger` itself (no child): level info,
//         message `partition_maintenance_disabled`, fields exactly { variable: 'DATABASE_MAINT_URL' }
//         (待编排会话确认). Otherwise maintenance.start() (its first run settles inside it, section
//         D of ./index.ts).
//      3. Resolves with a frozen plain object whose only own property is `stop`.
//    A start step that rejects (queue.start(), or maintenance.start() e.g. with wrong_role):
//      - cleanup, in order: maintenance.stop() (only when maintenance.start() had been called),
//        queue.stop(), then each function of `close` in order; a cleanup step that rejects does not
//        stop the following ones;
//      - then rejects with the very error of the failed start step (same object, not wrapped);
//      - when queue.start() rejects, maintenance.start() is never called and no
//        partition_maintenance_disabled line is written.
//    Stop — `services.stop()` (SIGTERM / SIGINT in the entry):
//      maintenance.stop() first (when maintenance is not null; it waits for the run in progress,
//      whose lock waits are bounded, section C of ./index.ts), then queue.stop(), then each function
//      of `close` in order. A step that rejects does not stop the following ones; after the last
//      step stop() resolves with undefined when every step resolved, otherwise rejects with the
//      error of the first step that rejected (same object). A second or concurrent call returns
//      the same promise as the first and calls nothing again.
//    startWorkerServices logs nothing else.
//
// 4. Entry wiring (apps/api/src/entry.ts, bootstrap.ts; checked by the rule test that runs the
//    built entries, test/spec/platform/maintenance/worker-entry.int.test.ts):
//    - runEntry: the problems of loadConfig, then of loadConnectionConfig, then of
//      loadMaintConnectionConfig(entry, process.env) (platform/db/maint.ts) go into the one
//      `config_invalid` line; exit code 1; nothing is created. Order of the worker start:
//      configuration → createDbHandles → createMaintDbHandle (only when the maintenance config is
//      not null) → createWorkerContext (the Nest context; maintenance is not part of the Nest
//      module, whose shape the existing rule tests fix) → startWorkerServices → `started`.
//    - The maintenance instance is createWorkerMaintenance({ db: <maintenance handle>.db, logger:
//      <root logger>, clock: <the process clock> }) — the same Clock instance the Nest context gets
//      (pass it through BootstrapOverrides.clock); intervalMs default. Per worker 契约 8.3–8.5,
//      it also maintains link_logs day partitions and warns on every nonempty DEFAULT partition.
//    - With COULI_EXIT_AFTER_INIT=1 the worker logs `started` { listening: false }, closes the
//      context and the maintenance handle and exits 0 without starting the queue or maintenance.
//    - `started` { listening: false } is logged after startWorkerServices resolved (so after the
//      first maintenance run settled); SIGTERM: `stopping`, services.stop(), `stopped`, exit 0.
//      Every pool, the maintenance pool included, is closed by services.stop(), so the process
//      exits right after `stopped` (well within 5 s), not after a pool's idle timeout.
//    - A startup failure after resources exist: they are all closed (startWorkerServices does it
//      for what it was given; anything created before it, e.g. the maintenance handle when the
//      context cannot be created, is closed by runEntry), `startup_failed`, exit code 1; no
//      password in any output.
//    - api, stream, admin and payout: unchanged — DATABASE_MAINT_URL is not read, no maintenance
//      pool, no partition_maintenance_* line (payout keeps its own start path; it never calls
//      startWorkerServices).
//    - .env.example: add DATABASE_MAINT_URL for the local stack (couli_maint), with a comment that
//      only the worker reads it.
//
// 5. Contract addendum to ./index.ts (sections B, C.5, E; its header is not edited — B1-01j's rule
//    tests stay as they are). New optional option of createPartitionMaintenance:
//      quietDefaultTables  optional array (Array.isArray, frozen or not) of 0..32 distinct strings,
//                          each matching /^[a-z][a-z0-9_]{0,62}$/; default [] (= current behaviour).
//                          Anything else (not an array, a non-string element, an empty or
//                          upper-case name, a duplicate, more than 32) → MaintenanceError
//                          ('invalid_option') synchronously. The list is copied at creation: later
//                          changes to the given array change nothing.
//    C.5 for a row with row_count > 0 whose table_name is in the list: still appended to
//    `defaultRows` (the report is unchanged), but logged as level info, message
//    `partition_default_rows_expected`, fields exactly { table, partition, rows } instead of the
//    warn line `partition_default_has_rows`; at the same position among the lines. Tables not in
//    the list are logged as before. Rows = 0 → no line, as before.
//
// 6. Rules for the implementation: section H of ./index.ts applies to this file too (erasable
//    syntax, no NestJS, no pg-boss, no `process.env`, no wall clock, logs only through the given
//    logger); `import type` for the queue types.
import type { RootLogger } from '../logging/logger.ts';
import { createPartitionMaintenance, MaintenanceError } from './index.ts';
import type { PartitionMaintenance, PartitionMaintenanceOptions } from './index.ts';

/** Something the worker starts and stops (the queue runtime, the maintenance schedule). */
export interface StartStop {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface WorkerServicesParts {
  readonly queue: StartStop;
  readonly maintenance: StartStop | null;
  readonly close: readonly (() => Promise<void>)[];
  readonly logger: RootLogger;
  /** Bounds maintenance shutdown, including failed-start cleanup; defaults to 5 seconds. */
  readonly maintenanceStopTimeoutMs?: number;
}

export interface WorkerServices {
  stop(): Promise<void>;
}

/** The worker's maintenance instance (section 2). */
export function createWorkerMaintenance(
  options: Omit<PartitionMaintenanceOptions, 'quietDefaultTables' | 'dayPartitions'>,
): PartitionMaintenance {
  if (
    options === null ||
    typeof options !== 'object' ||
    Object.getPrototypeOf(options) !== Object.prototype ||
    Reflect.ownKeys(options).some(
      (key) => !['db', 'logger', 'clock', 'intervalMs'].includes(String(key)),
    )
  )
    throw new MaintenanceError('invalid_option');
  return createPartitionMaintenance({
    ...options,
    dayPartitions: true,
  });
}

/** Starts queue then maintenance; the result stops them in reverse order (section 3). */
export async function startWorkerServices(parts: WorkerServicesParts): Promise<WorkerServices> {
  const timeout =
    parts.maintenanceStopTimeoutMs === undefined ? 5000 : parts.maintenanceStopTimeoutMs;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000) {
    throw new MaintenanceError('invalid_option');
  }
  const { queue, maintenance, logger } = parts;
  const close = [...parts.close];
  let maintenanceStarted = false;
  let stopping: Promise<void> | undefined;
  const stopMaintenance = async (): Promise<void> => {
    if (maintenance === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), timeout);
    });
    try {
      // The race also observes a late rejection after the shutdown deadline has passed.
      if ((await Promise.race([maintenance.stop(), expired])) === true) {
        logger.warn({ waitedMs: timeout }, 'partition_maintenance_stop_timeout');
      }
    } finally {
      clearTimeout(timer);
    }
  };
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      let failed = false;
      let firstError: unknown;
      const steps = [
        ...(maintenanceStarted && maintenance !== null ? [stopMaintenance] : []),
        () => queue.stop(),
        ...close,
      ];
      for (const step of steps) {
        try {
          await step();
        } catch (error) {
          if (!failed) firstError = error;
          failed = true;
        }
      }
      if (failed) throw firstError;
    })();
    return stopping;
  };
  try {
    await queue.start();
    if (maintenance === null) {
      logger.info({ variable: 'DATABASE_MAINT_URL' }, 'partition_maintenance_disabled');
    } else {
      maintenanceStarted = true;
      await maintenance.start();
    }
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
  return Object.freeze({ stop });
}
