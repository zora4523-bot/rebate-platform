// Rule tests of the periodic supervision of the queue runtime (contract addendum 1 in
// recovery.int.test.ts: supervision runs in the worker entry only — one pass in start(), then
// pg-boss repeats it every 60 s; an expired `active` job is failed like a handler failure, to
// `retry` while it has retries left; a job that is active but not yet expired is left alone).
// Gaps 1 and 2 of followups B1-01g (Claude code review round 1). Top-level it() only.
//
// Simulating 60 s without waiting them: the repetition is pg-boss's own timer, armed by start()
// through the global setTimeout (pg-boss's default clock), and the runtime offers no option for the
// interval or the clock. The tests therefore install fake setTimeout / clearTimeout before start()
// (shouldAdvanceTime keeps them running at wall-clock speed for the database I/O in between) and
// advance them by 60 s plus a margin. pg-boss gates each pass per queue on a server-side stamp that
// must be at least 60 s old (pgboss.queue.monitor_claim_on, else monitor_on); the tests move those
// stamps back by the same 60 s plus margin, the database half of the same elapsed time. Job expiry
// itself is real: started_on lies an hour in the past, expireInSeconds of the test catalog is 60.
// Because shouldAdvanceTime keeps the fake clock moving with wall time, #1 judges recovery inside a
// window only: it measures wall time from just before start() (the fake clock can be no further
// ahead of start() than that wall time plus ELAPSED_MS) and stops looking once a pass on a longer
// period (NEXT_PERIOD_MS) could have fired. A runtime whose period exceeds 60 s plus the margin
// is therefore red, not merely slower.
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { sql, type Kysely } from 'kysely';
import type { DB } from '@couli/db';
import { expect, it, vi } from 'vitest';
import { observe, sleep, waitFor } from './kit.ts';
import { closeObserver, observerOn, setupOn, stateOf, teardown, type Setup } from './int-kit.ts';

/** 60 s supervise interval plus margin. */
const ELAPSED_MS = 65_000;

/** The shortest wrong period #1 must tell apart from 60 s. */
const NEXT_PERIOD_MS = 90_000;

/** Wall time after start() during which no NEXT_PERIOD_MS pass can fire (5 s margin). */
const WINDOW_MS = NEXT_PERIOD_MS - ELAPSED_MS - 5_000;

/**
 * Polls `ready` every 50 ms while performance.now() is before `deadline` (real wall time: only
 * setTimeout / clearTimeout are faked); whether it got true in time. A check that starts after the
 * deadline does not count.
 */
async function trueBefore(ready: () => Promise<boolean>, deadline: number): Promise<boolean> {
  while (performance.now() < deadline) {
    if ((await ready()) && performance.now() < deadline) return true;
    await sleep(50);
  }
  return false;
}

async function withDatabase<T>(run: (database: TestDatabase) => Promise<T>): Promise<T> {
  const database = await createTestDatabase();
  try {
    return await run(database);
  } finally {
    await database.drop();
  }
}

function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
}

/** A process took the jobs and died: `active`, started an hour ago (expired). */
async function expire(observer: Kysely<DB>, ids: readonly string[]): Promise<void> {
  await sql`
    UPDATE pgboss.job SET state = 'active', started_on = now() - interval '1 hour'
    WHERE id = ANY(${[...ids]}::uuid[])
  `.execute(observer);
}

/** Database half of ELAPSED_MS: every per-queue supervise stamp is that much older. */
async function ageSuperviseStamps(observer: Kysely<DB>): Promise<void> {
  await sql`
    UPDATE pgboss.queue
    SET monitor_claim_on = monitor_claim_on - interval '65 seconds',
        monitor_on = monitor_on - interval '65 seconds'
  `.execute(observer);
}

it('[AC-B1-01zm#1] worker 启动之后（启动时那一轮监管已过）才出现的过期 active 任务：在 60 秒周期加余量内被下一轮监管回收（有重试余量的进 retry，含 payout 队列）；未过期的 active 任务不动；不写日志', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    const setups: Setup[] = [];
    try {
      return await observe(async () => {
        fakeTimers();
        // No handler is registered, so nothing fetches: a job leaves `active` only by supervision.
        const worker = setupOn(database, 'worker');
        setups.push(worker);
        // Taken before start() arms pg-boss's timer: the fake clock then is at most this far along.
        const deadline = performance.now() + WINDOW_MS;
        await worker.runtime.start();
        const send = async (queue: string, key?: string): Promise<string> =>
          (await worker.runtime.send(
            queue,
            'order.credited',
            { k: queue },
            key === undefined ? { trx: null } : { trx: null, singletonKey: key },
          )) ?? randomUUID();
        const ids = { std: await send('t-std'), pay: await send('t-pay', 'w:1') };
        const live = await send('t-wide');
        // These appear while the worker runs, after its startup pass.
        await expire(observer, [ids.std, ids.pay]);
        await sql`
          UPDATE pgboss.job SET state = 'active', started_on = now() WHERE id = ${live}::uuid
        `.execute(observer);
        await ageSuperviseStamps(observer);
        const before = {
          std: await stateOf(observer, 't-std', ids.std),
          pay: await stateOf(observer, 't-pay', ids.pay),
          live: await stateOf(observer, 't-wide', live),
        };
        await vi.advanceTimersByTimeAsync(ELAPSED_MS);
        const recovered = await trueBefore(
          async () =>
            (await stateOf(observer, 't-std', ids.std)) !== 'active' &&
            (await stateOf(observer, 't-pay', ids.pay)) !== 'active',
          deadline,
        );
        return {
          before,
          recovered,
          after: {
            std: await stateOf(observer, 't-std', ids.std),
            pay: await stateOf(observer, 't-pay', ids.pay),
            live: await stateOf(observer, 't-wide', live),
          },
          lines: worker.lines,
        };
      });
    } finally {
      await teardown(setups);
      await closeObserver(observer);
      vi.useRealTimers();
    }
  });
  expect(seen).toEqual({
    before: { std: 'active', pay: 'active', live: 'active' },
    recovered: true,
    after: { std: 'retry', pay: 'retry', live: 'active' },
    lines: [],
  });
}, 60_000);

it('[AC-B1-01zm#2] 只启动 payout、不启动 worker：别的队列（及 payout 自己队列）的过期 active 任务，无论启动前已过期还是运行中才过期，启动时与 60 秒周期加余量之后都保持 active；随后启动 worker 才被回收（对照：任务确实可回收）', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    const setups: Setup[] = [];
    try {
      return await observe(async () => {
        const sender = setupOn(database, 'api');
        setups.push(sender);
        await sender.runtime.start();
        const earlyStd =
          (await sender.runtime.send('t-std', 'order.credited', { k: 1 }, { trx: null })) ??
          randomUUID();
        const earlyPay =
          (await sender.runtime.send(
            't-pay',
            'order.credited',
            { k: 2 },
            { trx: null, singletonKey: 'w:2' },
          )) ?? randomUUID();
        const late =
          (await sender.runtime.send('t-wide', 'order.credited', { k: 3 }, { trx: null })) ??
          randomUUID();
        await sender.runtime.stop();
        // Expired before payout starts.
        await expire(observer, [earlyStd, earlyPay]);
        fakeTimers();
        const payout = setupOn(database, 'payout');
        setups.push(payout);
        await payout.runtime.start();
        const atStart = {
          std: await stateOf(observer, 't-std', earlyStd),
          pay: await stateOf(observer, 't-pay', earlyPay),
        };
        // Expired while payout runs.
        await expire(observer, [late]);
        await ageSuperviseStamps(observer);
        await vi.advanceTimersByTimeAsync(ELAPSED_MS);
        await sleep(3000);
        const afterInterval = {
          std: await stateOf(observer, 't-std', earlyStd),
          pay: await stateOf(observer, 't-pay', earlyPay),
          wide: await stateOf(observer, 't-wide', late),
        };
        // Control: the same jobs are recoverable — a worker's startup pass takes them.
        const worker = setupOn(database, 'worker');
        setups.push(worker);
        await worker.runtime.start();
        const recovered = await waitFor(
          async () =>
            (await stateOf(observer, 't-std', earlyStd)) !== 'active' &&
            (await stateOf(observer, 't-pay', earlyPay)) !== 'active' &&
            (await stateOf(observer, 't-wide', late)) !== 'active',
          15_000,
        );
        return {
          atStart,
          afterInterval,
          recovered,
          withWorker: {
            std: await stateOf(observer, 't-std', earlyStd),
            pay: await stateOf(observer, 't-pay', earlyPay),
            wide: await stateOf(observer, 't-wide', late),
          },
          lines: [...payout.lines, ...worker.lines],
        };
      });
    } finally {
      await teardown(setups);
      await closeObserver(observer);
      vi.useRealTimers();
    }
  });
  expect(seen).toEqual({
    atStart: { std: 'active', pay: 'active' },
    afterInterval: { std: 'active', pay: 'active', wide: 'active' },
    recovered: true,
    withWorker: { std: 'retry', pay: 'retry', wide: 'retry' },
    lines: [],
  });
}, 60_000);
