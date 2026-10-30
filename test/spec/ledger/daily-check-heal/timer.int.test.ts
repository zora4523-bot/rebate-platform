// B2-02r: the worker module's seed / heal timer (B2-02q: first tick within a minute of bootstrap,
// then every 30 minutes) decides from the actual state of the queue and the results, not from what
// the process sent before (task brief §9.1 / §9.2). The module's JOB_QUEUE forwards to pg-boss on
// the test database (api-entry runtime: sends only; the registered handler is only recorded), so
// the exclusive key really frees up when a job fails into ledger-check.dead. Fake timers replace
// setTimeout / setInterval only; PostgreSQL I/O, promises and the waits below stay real.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { LedgerDailyCheckModule } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { NestContext } from '../daily-check-schedule/kit.ts';
import {
  APP,
  DAY,
  NEXT_DAY,
  RUN_AT,
  TIMEOUT,
  capturedWorkerOptions,
  completeRun,
  dailyJobs,
  failToDead,
  memoryLogger,
  rootLogger,
  statesOf,
  userAccount,
  withDatabase,
  withRealQueue,
  workerContext,
} from './kit.ts';

/** The real setTimeout, taken before any fake timers are installed. */
const realSetTimeout = globalThis.setTimeout;

/** Polls `check` on real time (the ticks run real I/O) for up to `ms`. */
async function until(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => realSetTimeout(resolve, 50));
  }
  return check();
}

it(
  '[AC-B2-02r#12] worker 模块的修复定时器按实际状态：启动后补种入队；同一进程里该 (app, D) 进死信后，30 分钟内的修复重新入队；重跑完成后，之后的修复与重启后的补种都不再排该 D，链上的下一天只有 1 个',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await withRealQueue(db, async (queue) => {
        const clock = new FixedClock(RUN_AT);
        const root = rootLogger();
        const options = await capturedWorkerOptions(clock, root.logger);
        await userAccount(db, clock, APP);
        const { logger } = memoryLogger();
        const start = () =>
          workerContext(LedgerDailyCheckModule.forWorker(options), {
            clock,
            logger: root.logger,
            db,
            queue,
          });
        vi.useFakeTimers({
          toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        });
        let context: NestContext | undefined;
        try {
          context = await start();
          await vi.advanceTimersByTimeAsync(60_000);
          const seeded = await until(async () => (await statesOf(db, APP, DAY)).length > 0, 10_000);
          expect(seeded, 'no seed within a minute of bootstrap').toBe(true);
          expect(await statesOf(db, APP, DAY)).toStrictEqual(['created']);

          // Retries exhausted: the job fails into ledger-check.dead; the key is free again.
          const [job] = await dailyJobs(db, APP, DAY);
          await failToDead(db, job?.id ?? '00000000-0000-4000-8000-000000000000');
          await vi.advanceTimersByTimeAsync(30 * 60_000);
          const healed = await until(async () => (await statesOf(db, APP, DAY)).length > 1, 10_000);
          expect(healed, 'no heal within 30 minutes re-enqueued the dead-lettered (app, D)').toBe(
            true,
          );
          expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed', 'created']);

          // The re-sent job runs to completion and queues D+1.
          await completeRun(db, clock, queue, logger, APP, DAY);
          await vi.advanceTimersByTimeAsync(30 * 60_000);
          await until(async () => false, 1_000);
          expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed', 'completed']);

          // A restarted worker: the completed D is not queued again.
          await context.close();
          context = undefined;
          context = await start();
          await vi.advanceTimersByTimeAsync(60_000);
          await until(async () => false, 1_000);
          expect(await statesOf(db, APP, DAY)).toStrictEqual(['failed', 'completed']);
          expect(await statesOf(db, APP, NEXT_DAY)).toStrictEqual(['created']);
        } finally {
          await context?.close();
          vi.useRealTimers();
        }
      });
    });
  },
  TIMEOUT,
);
