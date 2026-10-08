import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { PgBoss } from 'pg-boss';
import type { RootLogger } from '../logging/logger.ts';
import { fetchAttempt, settleAttempt, type ClaimedJob } from './attempt.ts';
import type { JobHandler, WorkSpec } from './types.ts';

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
  db: Kysely<DB>;
  boss: PgBoss;
  logger: RootLogger;
  work: WorkSpec;
  handler: JobHandler;
  shutdown: AbortSignal;
  deadline: AbortSignal;
  runningHandlers: Set<Promise<void>>;
}

async function execute(options: ExecutorOptions, job: ClaimedJob): Promise<void> {
  const { db, boss, logger, work, handler, shutdown, deadline, runningHandlers } = options;
  const queue = work.queue;
  const fields = { queue, jobId: job.id, attempt: job.retryCount + 1 };
  const settle = async (succeeded: boolean): Promise<void> => {
    if (!(await settleAttempt(db, boss, queue, job, succeeded))) {
      logger.warn(fields, 'job_attempt_superseded');
    }
  };
  // A fetch already in flight may return after shutdown; never start business code then.
  // The signal check is a defensive guard for a fetched lease already released upstream.
  if (shutdown.aborted || job.signal?.aborted) {
    logger.warn(fields, shutdown.aborted ? 'job_released_on_stop' : 'job_released_on_expiry');
    await settle(false);
    return;
  }

  const expiry = new AbortController();
  const lease = AbortSignal.any([expiry.signal, deadline]);
  const timer = setTimeout(() => {
    logger.warn(fields, 'job_handler_overrun');
    expiry.abort();
  }, job.expireInSeconds * 1000);
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
      clearTimeout(timer);
      runningHandlers.delete(finished.promise);
      finished.resolve();
    }
  })();
  try {
    const succeeded = await untilAborted(handling, lease);
    // Exactly one settlement per fetched attempt; a late handler cannot complete a retry.
    await settle(succeeded === true);
  } finally {
    clearTimeout(timer);
    // Expiry ends the database lease, not this business execution slot. Only the shutdown
    // deadline lets a lane exit before its handler; no new fetch is possible after shutdown.
    await untilAborted(handling, deadline);
  }
}

/**
 * One lane owns its execution slot BEFORE fetching and keeps it through actual handler exit.
 * A round that executed a fetched job fetches again at once, so a backlog drains at handler
 * speed; only an empty or failed fetch waits one polling interval (no busy loop). The stop
 * signal is checked before every fetch and interrupts the wait.
 */
export async function runExecutor(options: ExecutorOptions): Promise<void> {
  const { db, boss, work, shutdown, logger } = options;
  while (!shutdown.aborted) {
    let executed = false;
    try {
      const jobs = await fetchAttempt(db, boss, work.queue);
      for (const job of jobs) {
        await execute(options, job);
        executed = true;
      }
    } catch (error) {
      reportQueueError(logger, error);
      // Settlement errors after a job are still failures: back off rather than spin.
      executed = false;
    }
    if (!executed && !shutdown.aborted) {
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
