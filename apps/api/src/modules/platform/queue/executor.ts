import type { JobWithMetadata, PgBoss } from 'pg-boss';
import type { RootLogger } from '../logging/logger.ts';
import type { JobHandler, JobPayload, WorkSpec } from './types.ts';

export interface Envelope {
  name: string;
  payload: JobPayload;
}

/** The only value ever stored for a failed business handler. */
const HANDLER_FAILED = Object.freeze({ error: 'handler_failed' });

export function reportQueueError(logger: RootLogger, error: unknown): void {
  const code = (error as { code?: unknown } | null)?.code;
  logger.error({ code: typeof code === 'string' ? code : null }, 'queue_error');
}

// A stop deadline can abandon a handler, but must detach its listener when it settles normally.
async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  const aborted = Promise.withResolvers<undefined>();
  const abort = () => aborted.resolve(undefined);
  signal.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([promise, aborted.promise]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export interface ExecutorOptions {
  boss: PgBoss;
  logger: RootLogger;
  work: WorkSpec;
  handler: JobHandler;
  shutdown: AbortSignal;
  deadline: AbortSignal;
  runningHandlers: Set<Promise<void>>;
}

async function execute(options: ExecutorOptions, job: JobWithMetadata<Envelope>): Promise<void> {
  const { boss, logger, work, handler, shutdown, deadline, runningHandlers } = options;
  const queue = work.queue;
  const fields = { queue, jobId: job.id, attempt: job.retryCount + 1 };
  // A fetch already in flight may return after shutdown; never start business code then.
  // The signal check is a defensive guard for a fetched lease already released upstream.
  if (shutdown.aborted || job.signal?.aborted) {
    logger.warn(fields, shutdown.aborted ? 'job_released_on_stop' : 'job_released_on_expiry');
    await boss.fail(queue, job.id, HANDLER_FAILED);
    return;
  }

  const expiry = new AbortController();
  const lease = AbortSignal.any([expiry.signal, deadline]);
  const timer = setTimeout(() => expiry.abort(), job.expireInSeconds * 1000);
  const finished = Promise.withResolvers<void>();
  runningHandlers.add(finished.promise);
  const handling = (async () => {
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
      return true;
    } catch {
      if (!lease.aborted) {
        const failure = { ...fields, jobName: job.data.name };
        if (job.retryCount < job.retryLimit) logger.warn(failure, 'job_failed');
        else logger.error(failure, 'job_failed_final');
      }
      return false;
    } finally {
      runningHandlers.delete(finished.promise);
      finished.resolve();
    }
  })();
  try {
    const succeeded = await untilAborted(handling, lease);
    // Exactly one settlement per fetched attempt; a late handler cannot complete a retry.
    if (succeeded === true) await boss.complete(queue, job.id);
    else await boss.fail(queue, job.id, HANDLER_FAILED);
  } finally {
    clearTimeout(timer);
    // Expiry ends the database lease, not this business execution slot. Only the shutdown
    // deadline lets a lane exit before its handler; no new fetch is possible after shutdown.
    await untilAborted(handling, deadline);
  }
}

/** One lane owns its execution slot BEFORE fetching and keeps it through actual handler exit. */
export async function runExecutor(options: ExecutorOptions): Promise<void> {
  const { boss, work, shutdown, logger } = options;
  while (!shutdown.aborted) {
    try {
      const jobs = await boss.fetch<Envelope>(work.queue, { batchSize: 1, includeMetadata: true });
      for (const job of jobs) await execute(options, job);
    } catch (error) {
      reportQueueError(logger, error);
    }
    if (!shutdown.aborted) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await untilAborted(
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, work.pollingIntervalSeconds * 1000);
          }),
          shutdown,
        );
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
