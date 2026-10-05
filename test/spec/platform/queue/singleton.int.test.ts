// Rule tests of the dedup key against a real PostgreSQL (ADR-0001 §4.2 第 19 项: 任务去重键映射到
// pg-boss 的 singletonKey，「同键任务还在队列里时新任务被静默丢弃」在 B1-01 实测; 规划/02 §5.3
// `{withdrawal_id}:{execute_seq}`、§7.1 窗口任务去重键; contract sections 3 and 4 of
// apps/api/src/modules/platform/queue/index.ts). On an exclusive queue a send with a key that is
// held by a created, retrying or active job returns null and inserts nothing; a completed or failed
// job releases the key; keys are scoped to the queue; a rolled-back send holds nothing.
// Top-level it() only (规划/11 §4.3).
import { createTestDatabase, type TestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import type { ReceivedJob } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import { gate, observe, waitFor } from './kit.ts';
import {
  closeObserver,
  observerOn,
  setupOn,
  stateOf,
  statesOfKey,
  teardown,
  type Setup,
} from './int-kit.ts';

class Rollback extends Error {}

async function withDatabase<T>(run: (database: TestDatabase) => Promise<T>): Promise<T> {
  const database = await createTestDatabase();
  try {
    return await run(database);
  } finally {
    await database.drop();
  }
}

/** 'id' for a job id, null for a dropped send, anything else as it is. */
function shape(value: unknown): unknown {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value) ? 'id' : value;
}

it('[ADR-0001 §4.2 #19; 规划/02 §5.3] exclusive 队列：同键任务排队（created）、执行中（active）、等待重试（retry）时再送都静默返回 null 且不新增行；不同键照常入队；同键在另一个队列互不影响', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let sender: Setup | undefined;
    let worker: Setup | undefined;
    const release = gate();
    let running = 0;
    try {
      return await observe(async () => {
        sender = setupOn(database, 'api');
        const s = sender;
        await s.runtime.start();
        const key = '0190a6a0-0000-7000-8000-0000000000b1:1';
        const send = (queue: string, singletonKey: string) =>
          s.runtime.send(queue, 'payout.execute', { k: singletonKey }, { trx: null, singletonKey });
        const steps: Record<string, unknown> = {};
        const first = await send('t-excl', key);
        steps.first = shape(first);
        steps.whileCreated = shape(await send('t-excl', key));
        steps.createdStates = await statesOfKey(observer, 't-excl', key);
        worker = setupOn(database, 'worker', {
          handlers: {
            't-excl': async (job: ReceivedJob) => {
              if ((job.payload as { k?: unknown }).k !== key) return;
              running += 1;
              await release.wait();
              throw new Error('step failed');
            },
          },
        });
        await worker.runtime.start();
        steps.becameActive = await waitFor(() => running === 1, 10_000);
        steps.whileActive = shape(await send('t-excl', key));
        steps.activeStates = await statesOfKey(observer, 't-excl', key);
        release.open();
        steps.becameRetry = await waitFor(
          async () => (await stateOf(observer, 't-excl', first ?? '')) === 'retry',
          10_000,
        );
        steps.whileRetry = shape(await send('t-excl', key));
        steps.retryStates = await statesOfKey(observer, 't-excl', key);
        steps.otherKey = shape(await send('t-excl', `${key}0`));
        steps.otherQueue = shape(await send('t-excl2', key));
        steps.senderLines = s.lines;
        return steps;
      });
    } finally {
      release.open();
      await teardown([worker, sender]);
      await closeObserver(observer);
    }
  });
  expect(seen).toEqual({
    first: 'id',
    whileCreated: null,
    createdStates: ['created'],
    becameActive: true,
    whileActive: null,
    activeStates: ['active'],
    becameRetry: true,
    whileRetry: null,
    retryStates: ['retry'],
    otherKey: 'id',
    otherQueue: 'id',
    senderLines: [],
  });
}, 60_000);

it('[ADR-0001 §4.2 #19] exclusive 队列：同键任务完成（completed）或最终失败（failed）后键被释放，再送入队成功；回滚事务里送出的键不占位', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let worker: Setup | undefined;
    try {
      return await observe(async () => {
        worker = setupOn(database, 'worker', {
          handlers: {
            't-excl2': async (job: ReceivedJob) => {
              if ((job.payload as { fail?: unknown }).fail === true) throw new Error('no');
            },
          },
        });
        const w = worker;
        await w.runtime.start();
        const send = (singletonKey: string, fail: boolean, trx: null = null) =>
          w.runtime.send('t-excl2', 'settle.bill', { fail }, { trx, singletonKey });
        const done = await send('win:done', false);
        const dead = await send('win:dead', true);
        const settledBoth = await waitFor(
          async () =>
            (await stateOf(observer, 't-excl2', done ?? '')) === 'completed' &&
            (await stateOf(observer, 't-excl2', dead ?? '')) === 'failed',
          15_000,
        );
        const afterCompleted = shape(await send('win:done', false));
        const afterFailed = shape(await send('win:dead', false));
        const inRollback = await w.handles.db
          .transaction()
          .execute(async (trx) => {
            await w.runtime.send(
              't-excl2',
              'settle.bill',
              { fail: false },
              { trx, singletonKey: 'win:rb' },
            );
            throw new Rollback();
          })
          .catch((error: unknown) => (error instanceof Rollback ? 'rolled back' : error));
        const afterRollback = shape(await send('win:rb', false));
        // Waits for the final state of the three later jobs (one per key) instead of a fixed
        // 1.5 s sleep: the t-excl2 lane (concurrency 1, polling 0.5 s) waits one interval after
        // each job, so three queued jobs can take longer than 1.5 s on a loaded host (B1-01v).
        // The assertions below are unchanged; a timeout leaves the states as they are.
        const final = (state: string | undefined): boolean =>
          state === 'completed' || state === 'failed';
        await waitFor(async () => {
          const [doneNow, deadNow, rbNow] = await Promise.all([
            statesOfKey(observer, 't-excl2', 'win:done'),
            statesOfKey(observer, 't-excl2', 'win:dead'),
            statesOfKey(observer, 't-excl2', 'win:rb'),
          ]);
          return (
            doneNow.length >= 2 &&
            doneNow.every(final) &&
            deadNow.length >= 2 &&
            deadNow.every(final) &&
            rbNow.length >= 1 &&
            rbNow.every(final)
          );
        }, 15_000);
        return {
          settledBoth,
          afterCompleted,
          afterFailed,
          inRollback,
          afterRollback,
          doneStates: await statesOfKey(observer, 't-excl2', 'win:done'),
          deadStates: await statesOfKey(observer, 't-excl2', 'win:dead'),
          rbStates: await statesOfKey(observer, 't-excl2', 'win:rb'),
        };
      });
    } finally {
      await teardown([worker]);
      await closeObserver(observer);
    }
  });
  expect(seen).toEqual({
    settledBoth: true,
    afterCompleted: 'id',
    afterFailed: 'id',
    inRollback: 'rolled back',
    afterRollback: 'id',
    doneStates: ['completed', 'completed'],
    deadStates: ['failed', 'completed'],
    rbStates: ['completed'],
  });
}, 60_000);

it('[ADR-0001 §4.2 #19] 同一事务里连送两次同键：第二次返回 null；提交后只有一个任务；standard 队列不接受 singletonKey（invalid_option），不带键的两次送都入队', async () => {
  const seen = await withDatabase(async (database) => {
    const observer = observerOn(database);
    let sender: Setup | undefined;
    try {
      return await observe(async () => {
        sender = setupOn(database, 'api');
        const s = sender;
        await s.runtime.start();
        const pair = await s.handles.db
          .transaction()
          .execute(async (trx) => [
            shape(await s.runtime.send('t-excl', 'a', {}, { trx, singletonKey: 'tx:1' })),
            shape(await s.runtime.send('t-excl', 'a', {}, { trx, singletonKey: 'tx:1' })),
          ]);
        const standard = [
          shape(await s.runtime.send('t-std', 'a', {}, { trx: null })),
          shape(await s.runtime.send('t-std', 'a', {}, { trx: null })),
        ];
        const keyed = await s.runtime
          .send('t-std', 'a', {}, { trx: null, singletonKey: 'tx:1' })
          .then(
            () => 'resolved',
            (error: unknown) =>
              `${(error as Error).name} ${String((error as { code?: unknown }).code)}`,
          );
        return {
          pair,
          states: await statesOfKey(observer, 't-excl', 'tx:1'),
          standard,
          keyed,
        };
      });
    } finally {
      await teardown([sender]);
      await closeObserver(observer);
    }
  });
  expect(seen).toEqual({
    pair: ['id', null],
    states: ['created'],
    standard: ['id', 'id'],
    keyed: 'QueueError invalid_option',
  });
}, 60_000);
