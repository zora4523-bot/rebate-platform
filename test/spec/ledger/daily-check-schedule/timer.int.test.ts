// B2-02q: the worker module's seed / heal timer (task brief §9.2: 模块补种 / 修复定时器; precedents
// payout-recon 15 s then every 30 min, union-auth 30 s then every 5 min): after bootstrap the chain
// is seeded within a minute, an app that appears later is picked up by a heal within 30 minutes,
// and nothing more is sent once the module is destroyed. Fake timers replace setTimeout /
// setInterval only; PostgreSQL I/O, promises and the clock of the waits below stay real.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it, vi } from 'vitest';
import { LedgerDailyCheckModule } from '../../../../apps/api/src/modules/ledger/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  APP,
  DAY,
  OTHER,
  RUN_AT,
  TIMEOUT,
  capturedWorkerOptions,
  expectedSend,
  fakeQueue,
  keyOf,
  rootLogger,
  sendView,
  sentFor,
  userAccount,
  withDatabase,
  workerContext,
  type NestContext,
} from './kit.ts';

/** The real setTimeout, taken before any fake timers are installed. */
const realSetTimeout = globalThis.setTimeout;

/** Polls `check` on real time (the seed's statements are real I/O) for up to `ms`. */
async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => realSetTimeout(resolve, 20));
  }
  return check();
}

it(
  '[AC-B2-02q#25] worker 模块的补种 / 修复定时器：启动后 1 分钟内为有账户的 app 排 D−1 的任务，30 分钟内的修复补上后来出现的 app；模块销毁后不再发送',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const clock = new FixedClock(RUN_AT);
      const root = rootLogger();
      const options = await capturedWorkerOptions(clock, root.logger);
      await userAccount(db, clock, APP);
      const queue = fakeQueue();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      let context: NestContext | undefined;
      try {
        context = await workerContext(LedgerDailyCheckModule.forWorker(options), {
          clock,
          logger: root.logger,
          db,
          queue,
        });
        await vi.advanceTimersByTimeAsync(60_000);
        const seeded = await until(() => sentFor(queue, APP).length > 0, 10_000);
        expect(seeded, 'no seed within a minute of bootstrap').toBe(true);
        expect(sentFor(queue, APP).map(sendView)).toContainEqual(expectedSend(APP, DAY, 0));

        await userAccount(db, clock, OTHER);
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        const healed = await until(() => sentFor(queue, OTHER).length > 0, 10_000);
        expect(healed, 'no heal within 30 minutes picked up the new app').toBe(true);
        expect(sentFor(queue, OTHER).map(sendView)).toContainEqual(expectedSend(OTHER, DAY, 0));
        // Every seed send is one of the two runs of D (no history, no other day).
        for (const job of queue.sent) {
          expect([keyOf(APP, DAY), keyOf(OTHER, DAY)]).toContain(job.options.singletonKey);
        }

        await context.close();
        context = undefined;
        const before = queue.sent.length;
        await vi.advanceTimersByTimeAsync(2 * 3_600_000);
        await until(() => false, 300);
        expect(queue.sent).toHaveLength(before);
      } finally {
        await context?.close();
        vi.useRealTimers();
      }
    });
  },
  TIMEOUT,
);
