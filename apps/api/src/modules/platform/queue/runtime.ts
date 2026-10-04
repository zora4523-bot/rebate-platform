import { sql } from 'kysely';
import { PgBoss, fromKysely, type JobWithMetadata } from 'pg-boss';
import {
  PGBOSS_SCHEMA,
  PGBOSS_SCHEMA_VERSION,
  QueueError,
  type JobHandler,
  type JobPayload,
  type QueueRuntime,
  type QueueRuntimeOptions,
  type QueueSpec,
} from './types.ts';
import { runtimeOptions, validateSend } from './validation.ts';

interface Envelope {
  name: string;
  payload: JobPayload;
}

/** The only value ever allowed to reach pg-boss from a failed business handler. */
const HANDLER_FAILED = Object.freeze({ error: 'handler_failed' });

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
  const working = new Set<string>();
  const runningHandlers = new Set<Promise<void>>();
  const slots = new Map(
    plan[entry].map((item) => [
      item.queue,
      { limit: item.concurrency, active: 0, waiters: new Set<() => void>() },
    ]),
  );
  const shutdown = new AbortController();
  const boss = new PgBoss({
    db: fromKysely(db),
    schema: PGBOSS_SCHEMA,
    migrate: false,
    supervise: entry === 'worker',
    schedule: false,
    reindex: false,
    persistQueueStats: false,
    useListenNotify: false,
  });
  boss.on('error', (error: unknown) => {
    const code = (error as { code?: unknown } | null)?.code;
    logger.error({ code: typeof code === 'string' ? code : null }, 'queue_error');
  });

  let used = false;
  let running = false;
  let stopping = false;
  let starting: Promise<void> | undefined;
  let stopped: Promise<void> | undefined;

  const execute = async (
    queue: string,
    handler: JobHandler,
    job: JobWithMetadata<Envelope>,
  ): Promise<void> => {
    // Pg-boss releases its worker on expiry even if business code is still running.
    // These slots belong to the actual handler lifetime, independently of that worker.
    const slot = slots.get(queue)!;
    const signal = AbortSignal.any([job.signal, shutdown.signal]);
    while (slot.active >= slot.limit && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const wake = () => {
          slot.waiters.delete(wake);
          signal.removeEventListener('abort', wake);
          resolve();
        };
        slot.waiters.add(wake);
        signal.addEventListener('abort', wake, { once: true });
      });
    }
    // offWork can race a fetch already in flight. Pg-boss will count this as a failure;
    // record the release without exposing business data, including on the final attempt.
    if (stopping) {
      logger.warn({ queue, jobId: job.id, attempt: job.retryCount + 1 }, 'job_released_on_stop');
      throw HANDLER_FAILED;
    }
    // An expired batch may have waited for a slot. Never start it after its lease ended.
    if (signal.aborted) throw HANDLER_FAILED;
    slot.active++;
    const finished = Promise.withResolvers<void>();
    runningHandlers.add(finished.promise);
    try {
      await handler(
        Object.freeze({
          id: job.id,
          queue,
          name: job.data.name,
          payload: job.data.payload,
          attempt: job.retryCount + 1,
        }),
      );
    } catch {
      // An abandoned callback may reject much later, after pg-boss has settled its batch.
      if (!job.signal.aborted) {
        const fields = {
          queue,
          jobName: job.data.name,
          jobId: job.id,
          attempt: job.retryCount + 1,
        };
        if (job.retryCount < job.retryLimit) logger.warn(fields, 'job_failed');
        else logger.error(fields, 'job_failed_final');
      }
      throw HANDLER_FAILED;
    } finally {
      runningHandlers.delete(finished.promise);
      finished.resolve();
      slot.active--;
      for (const wake of slot.waiters) wake();
    }
  };

  const start = async (): Promise<void> => {
    try {
      const version = await sql<{ version: number }>`SELECT version FROM pgboss.version`.execute(
        db,
      );
      if (version.rows.length !== 1 || version.rows[0]?.version !== PGBOSS_SCHEMA_VERSION) {
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
      await boss.start();
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
      // Recovery addendum 1: reclaim crashed workers' expired jobs, including payout jobs,
      // before registering any consumer. Pg-boss repeats supervision at its default 60 s interval.
      if (entry === 'worker') await boss.supervise();
      for (const [queue, handler] of handlers) {
        if (stopping) return;
        const item = work.get(queue)!;
        working.add(queue);
        const workOptions = {
          batchSize: 1,
          localConcurrency: item.concurrency,
          pollingIntervalSeconds: item.pollingIntervalSeconds,
          includeMetadata: true as const,
        };
        await boss.work<Envelope, void, typeof workOptions>(queue, workOptions, async (jobs) => {
          for (const job of jobs) await execute(queue, handler, job);
        });
      }
      if (!stopping) running = true;
    } catch (error) {
      running = false;
      stopping = true;
      shutdown.abort();
      await boss.stop({ close: false, graceful: false }).catch(() => undefined);
      throw error;
    }
  };

  const stop = async (): Promise<void> => {
    await starting?.catch(() => undefined);
    // Calling offWork synchronously marks workers stopping; its promise covers fetches in flight,
    // business handlers and their final complete/fail database statements.
    const workersDrained = Promise.allSettled(
      [...working].map((queue) => boss.offWork(queue, { wait: true })),
    );
    const drain = Promise.allSettled([...runningHandlers, workersDrained]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), stopTimeoutMs);
    });
    try {
      if ((await Promise.race([drain, deadline])) === 'timeout' && runningHandlers.size > 0) {
        logger.warn({ running: runningHandlers.size }, 'queue_stop_timeout');
      }
      // On timeout pg-boss fails and aborts its active batches. The original handler promise may
      // resolve later, but cannot settle a job again or hold pg-boss timers open.
      await boss.stop({ close: false, graceful: false });
      await workersDrained;
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
