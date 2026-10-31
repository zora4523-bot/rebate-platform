// B2-04ze round 2 (review r1 S1): SettlementModule.forWorker starts the daily bill seed and the due
// batch scan itself (D10-443, task brief §9.2): after bootstrap its timer ticks within 60 s and then
// at most every 60 s; each tick seeds the bill of the +08:00 day of the injected Clock for every app
// × platform and sends batch_execute for every CONFIRMED batch that is due by that Clock (decided
// from the queue and the database). Nothing calls seedSettleBills / scanDueBatches here: the
// module's own timer (fake setTimeout / setInterval) runs them, the Clock is moved across the bill
// day and the scheduled instant, and once the module is closed nothing more is sent.
// Real pieces: PostgreSQL (couli_app) and pg-boss on the test database (sends recorded and
// forwarded); the other modules' ports are the synthetic ones of kit.ts (not used by seed / scan).
import { createTestDatabase } from '@couli/db/testing';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, it, vi } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  APP,
  BILL,
  BILL_DAY,
  EXECUTE,
  FAKE_CRYPTO,
  QUEUE,
  TAOBAO,
  TIMEOUT,
  billKey,
  executeKey,
  fakeEventBus,
  fakePorts,
  seedBatch,
  seedOrder,
  settlementModule,
  silentRootLogger,
  withDatabase,
  withRealQueue,
  workerContext,
  type FakeQueue,
  type NestContext,
} from './kit.ts';

/** 2032-07-23 23:59 +08:00: the day before the bill day. */
const EVE = '2032-07-23T23:59:00+08:00';
const EVE_DAY = '2032-07-23';
/** The scheduled batch's instant, and one minute after it (bill day, after the snapshot window). */
const SCHEDULED_AT = '2032-07-24T00:40:00+08:00';
const AFTER_SCHEDULED = '2032-07-24T00:41:00+08:00';
/** After the module is closed: the next day. */
const NEXT_DAY_NOW = '2032-07-25T09:00:00+08:00';
const NEXT_DAY = '2032-07-25';
/** Upper bound of the first delay and of the period of the module's timer. */
const STEP_MS = 60_000;
/** Real-time bound of waiting for a tick's sends. */
const WAIT_MS = 60_000;

function keysOf(queue: FakeQueue): string[] {
  const settleSends = queue.sent.filter((job) => job.queue === QUEUE);
  return settleSends.map((job) => job.options.singletonKey ?? '');
}

/** The first send under `key` without its transaction handle. */
function sendOf(queue: FakeQueue, key: string) {
  const job = queue.sent.find((sent) => sent.options.singletonKey === key);
  if (job === undefined) return undefined;
  return {
    queue: job.queue,
    name: job.name,
    payload: job.payload,
    inTransaction: job.inTransaction,
  };
}

/** Lets the module's database work run (real I/O; the fake timers do not cover it). */
async function settle(db: Kysely<DB>): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await sql`SELECT 1`.execute(db);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Moves the fake timers on by one step at a time until every key has been sent. */
async function pumpUntil(db: Kysely<DB>, queue: FakeQueue, keys: readonly string[]) {
  const deadline = performance.now() + WAIT_MS;
  const missing = () => keys.filter((key) => !keysOf(queue).includes(key));
  while (missing().length > 0) {
    if (performance.now() > deadline) {
      expect.fail(`not sent by the module's own timer: ${missing().join(', ')}`);
    }
    await vi.advanceTimersByTimeAsync(STEP_MS);
    await settle(db);
  }
}

/** A few more steps of the timer (for what must not be sent). */
async function pumpSteps(db: Kysely<DB>, steps: number): Promise<void> {
  for (let step = 0; step < steps; step += 1) {
    await vi.advanceTimersByTimeAsync(STEP_MS);
    await settle(db);
  }
}

it(
  '[AC-B2-04ze#32] forWorker 自己起补种与扫描：启动后由模块定时器（≤60 秒首次、之后 ≤60 秒一次）按注入 Clock 补种当日 bill、投递到点的 CONFIRMED 批次；Clock 越过零点与定时时刻后补种新一天的 bill、投递定时批次；模块关闭后再推进定时器与 Clock 不再投递',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await seedOrder(db, APP, TAOBAO);
      const due = await seedBatch(db, APP, { status: 'CONFIRMED' });
      const later = await seedBatch(db, APP, {
        status: 'CONFIRMED',
        settleMode: 'SCHEDULED',
        scheduledAt: SCHEDULED_AT,
      });
      const clock = new FixedClock(EVE);
      const { ports, calls } = fakePorts({ snapshot: 'complete', config: new Map() });
      const SettlementModule = await settlementModule();

      await withRealQueue(db, async (queue) => {
        vi.useFakeTimers({
          toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
        });
        let context: NestContext | undefined;
        try {
          context = await workerContext(SettlementModule.forWorker(ports), {
            clock,
            logger: silentRootLogger(),
            db,
            queue,
            crypto: FAKE_CRYPTO,
            events: fakeEventBus(calls),
          });

          // Before midnight: the eve's bill and the immediate batch; not the scheduled one.
          await pumpUntil(db, queue, [billKey(APP, TAOBAO, EVE_DAY), executeKey(APP, due)]);
          await pumpSteps(db, 3);
          expect(sendOf(queue, billKey(APP, TAOBAO, EVE_DAY))).toStrictEqual({
            queue: QUEUE,
            name: BILL,
            payload: { app_id: APP, platform: TAOBAO, accounting_date: EVE_DAY },
            inTransaction: false,
          });
          expect(sendOf(queue, executeKey(APP, due))).toStrictEqual({
            queue: QUEUE,
            name: EXECUTE,
            payload: { app_id: APP, batch_id: due },
            inTransaction: false,
          });
          expect(keysOf(queue)).not.toContain(executeKey(APP, later));
          expect(keysOf(queue)).not.toContain(billKey(APP, TAOBAO, BILL_DAY));

          // The Clock crosses midnight and the scheduled instant.
          clock.set(AFTER_SCHEDULED);
          await pumpUntil(db, queue, [billKey(APP, TAOBAO, BILL_DAY), executeKey(APP, later)]);
          expect(sendOf(queue, billKey(APP, TAOBAO, BILL_DAY))?.payload).toStrictEqual({
            app_id: APP,
            platform: TAOBAO,
            accounting_date: BILL_DAY,
          });
          expect(sendOf(queue, executeKey(APP, later))?.payload).toStrictEqual({
            app_id: APP,
            batch_id: later,
          });

          // Closed: no more sends, whatever the timers and the Clock do.
          await context.close();
          context = undefined;
          const sentBefore = queue.sent.length;
          const afterStop = await seedBatch(db, APP, { status: 'CONFIRMED' });
          clock.set(NEXT_DAY_NOW);
          await pumpSteps(db, 10);
          expect(queue.sent.length).toBe(sentBefore);
          expect(keysOf(queue)).not.toContain(executeKey(APP, afterStop));
          expect(keysOf(queue)).not.toContain(billKey(APP, TAOBAO, NEXT_DAY));
        } finally {
          if (context !== undefined) await context.close();
          vi.useRealTimers();
        }
      });
    });
  },
  TIMEOUT,
);
