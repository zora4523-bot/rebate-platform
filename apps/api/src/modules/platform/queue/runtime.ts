// Queue runtime over pg-boss (B1-01g).
//
// Bounded start (B1-01zs). start() reads pgboss.version, then pg-boss reads it again inside
// boss.start() (Contractor.check) and runs further statements (queue reads, create/update, cache
// warm-up, its manager start). From the runtime's own version read until boss.start() returns,
// every statement runs in a transaction of its own, each on whichever pool connection that
// transaction borrows: first SELECT set_config('lock_timeout' | 'statement_timeout',
// START_STATEMENT_TIMEOUT, true) — transaction-local, i.e. SET LOCAL — then the statement, then
// COMMIT (ROLLBACK on error). Nothing has to be reset, so a pooled connection never keeps the
// limits, even when the ROLLBACK itself fails. A text that is already a pg-boss transaction
// (BEGIN; SET LOCAL lock_timeout = 30000; ...; COMMIT) runs unchanged: pg-boss bounds its lock
// waits itself. So a session holding a lock on pgboss.version (or another pg-boss table) makes
// that statement, and start(), reject within 20 s — the entry then logs startup_failed and exits
// 1 — instead of waiting forever. start() rejects as soon as the statement fails; the ROLLBACK
// that returns the connection runs afterwards, and stop() waits for it (at most stopTimeoutMs).
// 20 s is well above a short lock held during a deployment and below the rule tests' 60 s limit.
// The first supervise (worker) and everything after boss.start() returned — fetch, complete,
// fail, periodic supervise, send — run unbounded on the shared pool as before. A db without
// transaction() (unit-test doubles of the option, which only requires executeQuery) runs
// unbounded.
import { CompiledQuery, sql, type Kysely } from 'kysely';
import type { DB } from '@couli/db';
import { PgBoss, fromKysely } from 'pg-boss';
import { reportQueueError, runExecutor } from './executor.ts';
import {
  PGBOSS_SCHEMA,
  PGBOSS_SCHEMA_VERSION,
  QueueError,
  type JobHandler,
  type QueueRuntime,
  type QueueRuntimeOptions,
  type QueueSpec,
} from './types.ts';
import { runtimeOptions, validateSend } from './validation.ts';

/** Transaction-local lock_timeout / statement_timeout during start(), see the header. */
const START_STATEMENT_TIMEOUT = '20s';

/** pg-boss's own transaction texts (plans.transaction), which set their own lock_timeout. */
const OWN_TRANSACTION = /^\s*BEGIN\s*;/i;

function queueSettings(spec: QueueSpec) {
  return {
    retryLimit: spec.retryLimit,
    retryDelay: spec.retryDelaySeconds,
    retryBackoff: spec.retryBackoff,
    retryDelayMax: spec.retryDelayMaxSeconds,
    expireInSeconds: spec.expireInSeconds,
    retentionSeconds: spec.retentionSeconds,
    deleteAfterSeconds: spec.deleteAfterSeconds,
  };
}

export function createQueueRuntime(input: QueueRuntimeOptions): QueueRuntime {
  const options = runtimeOptions(input);
  const { db, logger, entry, catalog, plan, stopTimeoutMs } = options;
  const specs = new Map(catalog.map((spec) => [spec.name, spec]));
  const work = new Map(plan[entry].map((item) => [item.queue, item]));
  const handlers = new Map<string, JobHandler>();
  const executors: Promise<void>[] = [];
  const runningHandlers = new Set<Promise<void>>();
  const shutdown = new AbortController();
  const deadline = new AbortController();
  // ROLLBACKs (and COMMITs) still running after a bounded statement settled; stop() waits.
  const cleanups = new Set<Promise<void>>();
  const canBound = typeof db.transaction === 'function';
  /**
   * Runs `run` in its own transaction after the transaction-local limits. When the limits or the
   * statement fail, the result rejects at once with that error; the transaction's ROLLBACK goes
   * on in the background and is tracked in `cleanups`.
   */
  const bounded = <T>(run: (trx: Kysely<DB>) => Promise<T>): Promise<T> => {
    let failNow: (error: unknown) => void = () => undefined;
    const failed = new Promise<never>((_, reject) => {
      failNow = reject;
    });
    const transaction = db.transaction().execute(async (trx) => {
      try {
        await sql`SELECT set_config('lock_timeout', ${START_STATEMENT_TIMEOUT}, true),
          set_config('statement_timeout', ${START_STATEMENT_TIMEOUT}, true)`.execute(trx);
        return await run(trx);
      } catch (error) {
        failNow(error);
        throw error;
      }
    });
    const settled = transaction.then(
      () => undefined,
      () => undefined,
    );
    cleanups.add(settled);
    void settled.then(() => cleanups.delete(settled));
    // Both promises are observed by the race, so neither rejection is unhandled.
    return Promise.race([transaction, failed]);
  };
  // pg-boss's statements go through `bossDb`: bounded until boss.start() returns (the header).
  const plainDb = fromKysely(db);
  let bounding = false;
  const bossDb = {
    executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
      if (!bounding || !canBound || OWN_TRANSACTION.test(text)) {
        return plainDb.executeSql(text, values);
      }
      return bounded(async (trx) => {
        const result = await trx.executeQuery(CompiledQuery.raw(text, values ?? []));
        return { rows: [...result.rows] };
      });
    },
  };
  const readVersion = async (): Promise<readonly { version: number }[]> => {
    const read = (executor: Kysely<DB>) =>
      sql<{ version: number }>`SELECT version FROM pgboss.version`.execute(executor);
    return (canBound ? await bounded(read) : await read(db)).rows;
  };
  const boss = new PgBoss({
    db: bossDb,
    schema: PGBOSS_SCHEMA,
    migrate: false,
    supervise: entry === 'worker',
    schedule: false,
    reindex: false,
    persistQueueStats: false,
    useListenNotify: false,
  });
  boss.on('error', (error: unknown) => reportQueueError(logger, error));

  let used = false;
  let running = false;
  let stopping = false;
  let starting: Promise<void> | undefined;
  let stopped: Promise<void> | undefined;

  const start = async (): Promise<void> => {
    bounding = true;
    try {
      const version = await readVersion();
      if (version.length !== 1 || version[0]?.version !== PGBOSS_SCHEMA_VERSION) {
        throw new QueueError('schema_mismatch');
      }
      // Check ALL existing queues before making any changes or starting pg-boss timers.
      const existing = await boss.getQueues();
      const byName = new Map(existing.map((queue) => [queue.name, queue]));
      for (const spec of catalog) {
        const queue = byName.get(spec.name);
        if (
          queue !== undefined &&
          (queue.policy !== spec.policy ||
            (queue.deadLetter ?? null) !== spec.deadLetter ||
            queue.partition)
        ) {
          throw new QueueError('queue_mismatch');
        }
      }
      if (stopping) return;
      // A dead-letter target must exist before a queue referencing it is created.
      const ordered = [
        ...catalog.filter((spec) => spec.deadLetter === null),
        ...catalog.filter((spec) => spec.deadLetter !== null),
      ];
      for (const spec of ordered) {
        if (stopping) return;
        const settings = queueSettings(spec);
        if (!byName.has(spec.name)) {
          const { retryDelayMax, ...createSettings } = settings;
          await boss.createQueue(spec.name, {
            ...createSettings,
            ...(retryDelayMax === null ? {} : { retryDelayMax }),
            policy: spec.policy,
            partition: false,
            ...(spec.deadLetter === null ? {} : { deadLetter: spec.deadLetter }),
          });
        } else {
          await boss.updateQueue(spec.name, settings);
        }
      }
      if (stopping) return;
      // createQueue/updateQueue evict pg-boss's metadata cache. A read through findJobs
      // fills it (getQueue/getQueues do not), without claiming or inserting a job.
      // Warm every queue before send is available: a cold lookup uses the shared pool
      // even when send itself is given a transaction, which can deadlock a full pool.
      for (const spec of catalog) {
        if (stopping) return;
        await boss.findJobs(spec.name, { id: '00000000-0000-0000-0000-000000000000' });
      }
      // No periodic cache snapshot may start until every catalog queue exists and is warm.
      // Otherwise a slow startup can publish an older snapshot after the warm-up above.
      await boss.start();
      // Bounded start statements end here: supervise, consumers and timers run unbounded.
      bounding = false;
      if (stopping) return;
      // Recovery addendum 1: reclaim crashed workers' expired jobs, including payout jobs,
      // before registering any consumer. Pg-boss repeats supervision at its default 60 s interval.
      if (entry === 'worker') await boss.supervise();
      for (const [queue, handler] of handlers) {
        if (stopping) return;
        const item = work.get(queue)!;
        for (let slot = 0; slot < item.concurrency; slot++) {
          executors.push(
            runExecutor({
              db,
              boss,
              logger,
              work: item,
              handler,
              shutdown: shutdown.signal,
              deadline: deadline.signal,
              runningHandlers,
            }),
          );
        }
      }
      if (!stopping) running = true;
    } catch (error) {
      bounding = false;
      running = false;
      stopping = true;
      shutdown.abort();
      deadline.abort();
      await Promise.allSettled(executors);
      await boss.stop({ close: false, graceful: false }).catch(() => undefined);
      throw error;
    } finally {
      // Also after an early return because stop() was called during start().
      bounding = false;
    }
  };

  const stop = async (): Promise<void> => {
    await starting?.catch(() => undefined);
    if (cleanups.size > 0) {
      // A failed bounded start statement: let its ROLLBACK return the connection first.
      let wait: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...cleanups]),
        new Promise<void>((resolve) => {
          wait = setTimeout(resolve, stopTimeoutMs);
        }),
      ]);
      clearTimeout(wait);
    }
    const workersDrained = Promise.allSettled(executors);
    const drain = Promise.allSettled([...runningHandlers, workersDrained]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), stopTimeoutMs);
    });
    try {
      if ((await Promise.race([drain, timeout])) === 'timeout' && runningHandlers.size > 0) {
        logger.warn({ running: runningHandlers.size }, 'queue_stop_timeout');
      }
      // Release active leases on timeout, then await every fetch and settlement statement
      // before the entry closes its shared pool. Late handlers cannot write queue state.
      deadline.abort();
      await workersDrained;
      await boss.stop({ close: false, graceful: false });
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    register(queue, handler): void {
      if (!specs.has(queue)) throw new QueueError('unknown_queue');
      if (!work.has(queue)) throw new QueueError('not_in_entry');
      if (typeof handler !== 'function') throw new QueueError('invalid_option');
      if (handlers.has(queue)) throw new QueueError('duplicate_handler');
      if (used) throw new QueueError('already_started');
      handlers.set(queue, handler);
    },
    async send(queue, name, payload, sendOptions) {
      const spec = specs.get(queue);
      if (spec === undefined) throw new QueueError('unknown_queue');
      validateSend(spec, name, payload, sendOptions);
      if (!running) throw new QueueError('not_running');
      return boss.send(
        queue,
        { name, payload },
        {
          ...(sendOptions.trx === null ? {} : { db: fromKysely(sendOptions.trx) }),
          ...(sendOptions.id === undefined ? {} : { id: sendOptions.id }),
          ...(sendOptions.singletonKey === undefined
            ? {}
            : { singletonKey: sendOptions.singletonKey }),
          ...(sendOptions.delaySeconds === undefined
            ? {}
            : { startAfter: sendOptions.delaySeconds }),
        },
      );
    },
    start(): Promise<void> {
      if (used) return Promise.reject(new QueueError('already_started'));
      used = true;
      starting = start();
      return starting;
    },
    stop(): Promise<void> {
      if (stopped !== undefined) return stopped;
      used = true;
      running = false;
      stopping = true;
      shutdown.abort();
      stopped = stop().catch(() => undefined);
      return stopped;
    },
  };
}
