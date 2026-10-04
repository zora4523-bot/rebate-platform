// Rule tests of the recovery of jobs left `active` by a process that died after taking them
// (ADR-0001 §3「至少一次投递」; 规划/02 §11, §18 领域事件一行; contract section 5 of
// apps/api/src/modules/platform/queue/index.ts plus the addendum below). Top-level it() only.
//
// Contract addendum 1 (B1-01g rule-test review round 1) — expiry and who supervises:
//   - A job stays `active` from the moment a worker takes it until its completion or failure is
//     written. When the process dies in between, nothing else settles it: the job is recovered by
//     pg-boss supervision, which fails every `active` job whose started_on + expireInSeconds is in
//     the past (PostgreSQL time, pgboss.job_now()).
//   - Supervision runs in the worker entry only (section 5 step 3): its start(), after the queue
//     step and before any queue is worked, runs ONE supervision pass over the queues (pg-boss
//     `supervise()`), then pg-boss repeats it every 60 s (its default supervise / monitor
//     intervals). The worker entry therefore also recovers the jobs of the payout queue. A pass
//     right after another instance's pass may skip the expiry check (pg-boss claims it per queue
//     per interval); the next pass catches up.
//   - An expired job is failed exactly like a handler failure, except that no log line is written
//     and its output is whatever pg-boss stores for a timeout: while it has retries left it goes to
//     `retry` and is delivered again after the retry delay with the SAME job id and attempt + 1
//     (to whichever entry works its queue); without retries left it becomes `failed` and is copied
//     into the dead letter queue. A job that is active but not yet expired is left alone (another
//     live process may still be running it).
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import type { ReceivedJob } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { observe, sleep, waitFor } from './kit.ts';
import {
  closeObserver,
  deadCopies,
  observerOn,
  recorder,
  setupOn,
  stateOf,
  teardown,
  type Setup,
} from './int-kit.ts';

async function withDatabase<T>(run: (database: TestDatabase) => Promise<T>): Promise<T> {
  const database = await createTestDatabase();
  try {
    return await run(database);
  } finally {
    await database.drop();
  }
}

it('[ADR-0001 §3 至少一次; contract 补充 1] 进程取走任务后崩溃留下的过期 active 任务：新 worker 启动即回收，以同一 job id、attempt 2 再次交付并完成（payout 队列由 payout 入口重新执行）；没有重试余量的进死信；未过期的 active 任务不动；不写日志', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    const setups: Setup[] = [];
    const worked = recorder();
    const paid = recorder();
    try {
      return await observe(async () => {
        const sender = setupOn(database, 'api');
        setups.push(sender);
        await sender.runtime.start();
        const send = (queue: string, key?: string) =>
          sender.runtime.send(
            queue,
            'order.credited',
            { k: queue },
            key === undefined ? { trx: null } : { trx: null, singletonKey: key },
          );
        const ids = {
          std: (await send('t-std')) ?? randomUUID(),
          pay: (await send('t-pay', 'w:1')) ?? randomUUID(),
          once: (await send('t-once')) ?? randomUUID(),
          live: (await send('t-wide')) ?? randomUUID(),
        };
        await sender.runtime.stop();
        // A process took all four and died; three of them expired long ago (expireInSeconds 60).
        await sql`
          UPDATE pgboss.job SET state = 'active', started_on = now() - interval '1 hour'
          WHERE id IN (${ids.std}::uuid, ${ids.pay}::uuid, ${ids.once}::uuid)
        `.execute(observer);
        await sql`
          UPDATE pgboss.job SET state = 'active', started_on = now() WHERE id = ${ids.live}::uuid
        `.execute(observer);
        const track = (rec: ReturnType<typeof recorder>) => (job: ReceivedJob) =>
          rec.track(job.id, job.queue, job.name, job.attempt, async () => undefined);
        const worker = setupOn(database, 'worker', {
          handlers: { 't-std': track(worked), 't-once': track(worked), 't-wide': track(worked) },
        });
        setups.push(worker);
        const payout = setupOn(database, 'payout', { handlers: { 't-pay': track(paid) } });
        setups.push(payout);
        await worker.runtime.start();
        await payout.runtime.start();
        const recovered = await waitFor(
          async () =>
            (await stateOf(observer, 't-std', ids.std)) === 'completed' &&
            (await stateOf(observer, 't-pay', ids.pay)) === 'completed' &&
            (await deadCopies(observer, ids.once)).length === 1,
          15_000,
        );
        await sleep(2000);
        const name = (id: string): string =>
          Object.entries(ids).find(([, value]) => value === id)?.[0] ?? 'other';
        return {
          recovered,
          worked: worked.calls.map((call) => [name(call.id), call.queue, call.attempt]),
          paid: paid.calls.map((call) => [name(call.id), call.queue, call.attempt]),
          once: await stateOf(observer, 't-once', ids.once),
          dead: (await deadCopies(observer, ids.once)).map((copy) => [copy.queue, copy.sourceName]),
          live: await stateOf(observer, 't-wide', ids.live),
          lines: [...worker.lines, ...payout.lines],
        };
      });
    } finally {
      await teardown(setups);
      await closeObserver(observer);
    }
  });
  expect(seen).toEqual({
    recovered: true,
    worked: [['std', 't-std', 2]],
    paid: [['pay', 't-pay', 2]],
    once: 'failed',
    dead: [['test-dead', 't-once']],
    live: 'active',
    lines: [],
  });
}, 60_000);
