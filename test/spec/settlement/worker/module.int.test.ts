// B2-04ze: SettlementModule.forWorker (D10-443): one handler on the existing queue settle over the
// real bill job (production readSource + saveBillValidations), batch executor, credit and gate,
// built from the ports app.module hands in; nothing registered without a database or queue. The
// other modules' ports are synthetic here (recording stand-ins); the switches follow the current
// rules: settle.auto.enabled unset = on, credit.enabled.<platform> unset = off (08 BR-FUND-04 ⑦ ⑨,
// BR-CALC-03, BR-FUND-20), so by default nothing is credited.
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  APP,
  BILL,
  BILL_DAY,
  BILL_DAY_NOW,
  BILL_DAY_START,
  BILL_MONTH,
  EXECUTE,
  FAKE_CRYPTO,
  PLAIN_DAY,
  PLAIN_DAY_NOW,
  QUEUE,
  SCAN_NOW,
  TAOBAO,
  TIMEOUT,
  batchRow,
  fakeEventBus,
  fakePorts,
  fakeQueue,
  receivedJob,
  refusal,
  seedBatch,
  seedOrder,
  settleHandler,
  settleJobsOf,
  settlementModule,
  silentRootLogger,
  withDatabase,
  workerContext,
  type FakeQueue,
  type PortCalls,
  type PortState,
} from './kit.ts';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import type { JobHandler } from '../../../../apps/api/src/modules/platform/index.ts';

const UNKNOWN_BATCH = '0190f000-0000-7000-8000-0000000000ff';

/** The assembled worker module over `db` at `now`; runs `body` with its settle handler. */
async function withAssembled(
  db: Kysely<DB>,
  now: string,
  state: PortState,
  body: (h: { handler: JobHandler; calls: PortCalls; queue: FakeQueue }) => Promise<void>,
): Promise<void> {
  const { ports, calls } = fakePorts(state);
  const SettlementModule = await settlementModule();
  const queue = fakeQueue();
  const context = await workerContext(SettlementModule.forWorker(ports), {
    clock: new FixedClock(now),
    logger: silentRootLogger(),
    db,
    queue,
    crypto: FAKE_CRYPTO,
    events: fakeEventBus(calls),
  });
  try {
    await body({ handler: settleHandler(queue), calls, queue });
  } finally {
    await context.close();
  }
}

async function countRows(
  db: Kysely<DB>,
  table: 'settle_bills' | 'settle_batches' | 'settle_jobs',
): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM ${sql.table(`app.${table}`)}`.execute(db);
  return rows[0]?.n ?? Number.NaN;
}

it(
  '[AC-B2-04ze#22] forWorker：有库、队列（与密钥、事件总线）时在 settle 队列上恰注册 1 个处理器、不注册别的队列；没有库或没有队列时什么都不注册',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const SettlementModule = await settlementModule();
      const state: PortState = { snapshot: 'complete', config: new Map() };

      const full = fakeQueue();
      const { ports, calls } = fakePorts(state);
      const context = await workerContext(SettlementModule.forWorker(ports), {
        clock: new FixedClock(SCAN_NOW),
        logger: silentRootLogger(),
        db,
        queue: full,
        crypto: FAKE_CRYPTO,
        events: fakeEventBus(calls),
      });
      try {
        expect(full.registered.map((entry) => entry.queue)).toStrictEqual([QUEUE]);
      } finally {
        await context.close();
      }

      const noDb = fakeQueue();
      const withoutDb = await workerContext(SettlementModule.forWorker(fakePorts(state).ports), {
        clock: new FixedClock(SCAN_NOW),
        logger: silentRootLogger(),
        queue: noDb,
        crypto: FAKE_CRYPTO,
        events: fakeEventBus(calls),
      });
      try {
        expect(noDb.registered).toStrictEqual([]);
      } finally {
        await withoutDb.close();
      }

      const withoutQueue = await workerContext(SettlementModule.forWorker(fakePorts(state).ports), {
        clock: new FixedClock(SCAN_NOW),
        logger: silentRootLogger(),
        db,
        crypto: FAKE_CRYPTO,
        events: fakeEventBus(calls),
      });
      await withoutQueue.close();
      expect(await countRows(db, 'settle_jobs')).toBe(0);
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04ze#23] 装配的处理器：非账单日的 bill 正常完成（not_due，不写 settle_jobs / settle_bills）；不存在的批次的 batch_execute 正常完成且什么都不写',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await seedOrder(db, APP, TAOBAO);
      await withAssembled(
        db,
        PLAIN_DAY_NOW,
        { snapshot: 'complete', config: new Map() },
        async ({ handler, calls }) => {
          await handler(
            receivedJob(BILL, { app_id: APP, platform: TAOBAO, accounting_date: PLAIN_DAY }),
          );
          await handler(receivedJob(EXECUTE, { app_id: APP, batch_id: UNKNOWN_BATCH }));
          expect(await countRows(db, 'settle_jobs')).toBe(0);
          expect(await countRows(db, 'settle_bills')).toBe(0);
          expect(calls.unionAuthoritative).toStrictEqual([]);
          expect(calls.diffs).toStrictEqual([]);
          expect(calls.published).toStrictEqual([]);
        },
      );
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04ze#24] 装配的处理器：账单日而当日资产快照未完成时 bill 本次投递失败（deferred），不写 settle_jobs、settle_bills',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      await seedOrder(db, APP, TAOBAO);
      await withAssembled(
        db,
        BILL_DAY_NOW,
        { snapshot: 'pending', config: new Map() },
        async ({ handler }) => {
          await refusal(() =>
            handler(
              receivedJob(BILL, { app_id: APP, platform: TAOBAO, accounting_date: BILL_DAY }),
            ),
          );
          expect(await countRows(db, 'settle_jobs')).toBe(0);
          expect(await countRows(db, 'settle_bills')).toBe(0);
        },
      );
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04ze#25] 装配的处理器：账单日快照已完成时 bill 经生产 readSource（联盟为准读口取本平台订单键）生成账单，应结未结登记差错单，settle_jobs 记 (bill, 平台, D 00:00 +08:00) done；credit.enabled 未设（缺省 off）不生成批次、不读归属',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const missing = await seedOrder(db, APP, TAOBAO);
      await withAssembled(
        db,
        BILL_DAY_NOW,
        { snapshot: 'complete', config: new Map() },
        async ({ handler, calls }) => {
          await handler(
            receivedJob(BILL, { app_id: APP, platform: TAOBAO, accounting_date: BILL_DAY }),
          );
          const jobs = await settleJobsOf(db, APP);
          expect(
            jobs.map((row) => ({
              job: row.job,
              platform: row.platform,
              run_at: row.run_at.toISOString(),
              status: row.status,
            })),
          ).toStrictEqual([
            { job: 'bill', platform: TAOBAO, run_at: BILL_DAY_START, status: 'done' },
          ]);
          const bills = await db
            .withSchema('app')
            .selectFrom('settle_bills')
            .select(['bill_id', 'generated_at'])
            .where('app_id', '=', APP)
            .execute();
          expect(bills.map((row) => row.bill_id)).toStrictEqual([BILL_MONTH]);
          expect(bills[0]?.generated_at).not.toBeNull();
          expect(calls.unionAuthoritative).toStrictEqual([
            { appId: APP, orderKeys: [missing.key] },
          ]);
          expect(calls.diffs.map((diff) => ({ type: diff.type, refId: diff.refId }))).toStrictEqual(
            [{ type: 'settle_missing', refId: missing.key }],
          );
          expect(await countRows(db, 'settle_batches')).toBe(0);
          expect(calls.attribution).toStrictEqual([]);
        },
      );
    });
  },
  TIMEOUT,
);

it(
  '[AC-B2-04ze#26] 装配的处理器：CONFIRMED 立即批次在 credit.enabled 未设（缺省 off）时只记 paused_by_switch_at、保持 CONFIRMED、不入账；credit.enabled=on 而 settle.auto.enabled 未设（缺省 on）时执行到 DONE 并发 settle.batch_done',
  async () => {
    await withDatabase(createTestDatabase, async (db) => {
      const stopped = await seedBatch(db, APP, { status: 'CONFIRMED' });
      const state: PortState = { snapshot: 'complete', config: new Map() };
      await withAssembled(db, SCAN_NOW, state, async ({ handler, calls }) => {
        await handler(receivedJob(EXECUTE, { app_id: APP, batch_id: stopped }));
        const row = await batchRow(db, stopped);
        expect(row.status).toBe('CONFIRMED');
        expect(row.paused_by_switch_at?.toISOString()).toBe(SCAN_NOW);
        expect(row.started_at).toBeNull();
        expect(calls.published).toStrictEqual([]);
        expect(calls.attribution).toStrictEqual([]);
      });

      const runs = await seedBatch(db, APP, { status: 'CONFIRMED' });
      state.config.set(`credit.enabled.${TAOBAO}`, true);
      await withAssembled(db, SCAN_NOW, state, async ({ handler, calls }) => {
        await handler(receivedJob(EXECUTE, { app_id: APP, batch_id: runs }));
        const row = await batchRow(db, runs);
        expect(row.status).toBe('DONE');
        expect(row.finished_at?.toISOString()).toBe(SCAN_NOW);
        expect(calls.published.map((event) => (event as { name?: unknown }).name)).toStrictEqual([
          'settle.batch_done',
        ]);
      });
      // The stopped batch stays where the switch left it.
      expect((await batchRow(db, stopped)).status).toBe('CONFIRMED');
    });
  },
  TIMEOUT,
);
