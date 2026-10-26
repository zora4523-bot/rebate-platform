// B2-15m rule-test kit (claude-independent, SPEC_REF 736d24c5; 08 BR-PAY-07「每日 T+1 用渠道的交易账单
// …逐笔核对」; B2-15j bill.recon and its singletonKey per App and bill day, jobs/names.ts).
// Real pieces: the reconciliation and its job handler (B2-15j, ../recon/kit.ts over ../result/kit.ts
// jobKit: ledger's real posting and recon diff registration), the seed of the daily chain
// (apps/api/src/modules/payment/application/pay-recon-schedule.ts), PostgreSQL through
// @couli/db/testing as couli_app, pg-boss on the test database (platform/queue createQueueRuntime,
// the real catalog and entry plan) and the real worker entry (bootstrap.createWorkerContext with the
// fixture's database and clock; only its JOB_QUEUE is a recorder). Synthetic: the channel bills
// (../recon/kit.ts BillChannel). No real merchant or payer data.
// Missing pieces fail as NotImplemented (the skeleton) or as assertions (nothing enqueued, the
// wrong bill day enqueued). Plain SQL always names the schema.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { vi } from 'vitest';
import {
  seedBillRecon,
  type PayReconSeedDeps,
} from '../../../../apps/api/src/modules/payment/application/pay-recon-schedule.ts';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import {
  createRootLogger,
  type DbHandles,
  type FixedClock,
  type JobHandler,
  type JobPayload,
  type QueueRuntime,
  type RootLogger,
  type SendOptions,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { createQueueRuntime } from '../../../../apps/api/src/modules/platform/queue/index.ts';
import type { Fixture } from '../orders/kit.ts';
import { payJobHandler, received, sends, type JobKit, type SentJob } from '../result/kit.ts';
import { lineOf, paidOrder, type Recon } from '../recon/kit.ts';

export const BILL_RECON_JOB = 'bill.recon';
export const PAY_QUEUE = 'pay';

/** A run that is «due at once»: at most this many seconds of delay. */
export const AT_ONCE_SECONDS = 60;

/** 10:00 +08:00 of a bill day (inside it), as an instant. */
export function inDay(billDate: string): string {
  return new Date(Date.parse(`${billDate}T10:00:00+08:00`)).toISOString();
}

/** 00:00 +08:00 of the day after `billDate`: the bill day is over (epoch milliseconds). */
export function dayEndMs(billDate: string): number {
  return Date.parse(`${billDate}T00:00:00+08:00`) + 86_400_000;
}

/** The instant a recorded send becomes due: the clock's now (fixed in these tests) + its delay. */
export function dueMs(clock: FixedClock, job: SentJob): number {
  return clock.now().getTime() + (job.options.delaySeconds ?? 0) * 1000;
}

/** The recorded daily bill.recon sends of the app (no pay_channel), in send order. */
export function dailySends(kit: JobKit, appId: string): SentJob[] {
  return sends(kit, BILL_RECON_JOB).filter(
    (job) => job.payload['app_id'] === appId && job.payload['pay_channel'] === undefined,
  );
}

/** The recorded catch-up sends of the app (one channel's bill day), in send order. */
export function catchUpSends(kit: JobKit, appId: string): SentJob[] {
  return sends(kit, BILL_RECON_JOB).filter(
    (job) => job.payload['app_id'] === appId && job.payload['pay_channel'] !== undefined,
  );
}

/** The bill_date a send carries ('' when none). */
export function billDateOf(job: SentJob): string {
  const value = job.payload['bill_date'];
  return typeof value === 'string' ? value : '';
}

/** The seed of the daily chain over the kit's dependencies (the skeleton throws NotImplemented). */
export async function seed(kit: JobKit): Promise<void> {
  await seedBillRecon(kit.deps as unknown as PayReconSeedDeps);
}

/** The pay queue's handler over the kit; one bill.recon job of `payload` through it. */
export async function reconHandler(kit: JobKit): Promise<(payload: JobPayload) => Promise<void>> {
  const handler: JobHandler = await payJobHandler(kit);
  return (payload) => handler(received(BILL_RECON_JOB, payload));
}

/**
 * For each channel, one PAID order paid inside the bill day and the bill of that day listing it
 * with the given fee: a clean day (no recon diff) whose PAY_FEE is that fee.
 */
export async function cleanDay(
  r: Recon,
  billDate: string,
  fees: Record<PayChannelCode, bigint>,
): Promise<void> {
  for (const channel of ['wechat_pay', 'alipay'] as const) {
    const order = await paidOrder(r, channel, { paidAt: inDay(billDate) });
    r.channels[channel].setBill(billDate, [lineOf(order, { feeFen: fees[channel] })]);
  }
}

// ---------------------------------------------------------------------------------------------
// pg-boss on the test database.

export interface ReconJobRow {
  readonly state: string;
  readonly singleton_key: string | null;
  readonly payload: JobPayload | null;
}

/** The bill.recon jobs of queue `pay` whose data names the app (pgboss.job, oldest first). */
export async function reconJobs(f: Fixture, appId: string): Promise<ReconJobRow[]> {
  const result = await sql<ReconJobRow>`
    SELECT state::text AS state, singleton_key, data->'payload' AS payload
    FROM pgboss.job
    WHERE name = 'pay' AND data->>'name' = ${BILL_RECON_JOB} AND data::text LIKE ${`%${appId}%`}
    ORDER BY created_on, id`.execute(f.db);
  return result.rows;
}

/** A started job queue of the api entry on the test database (sends only); stopped by `run`'s end. */
export async function withQueue(
  f: Fixture,
  run: (queue: QueueRuntime) => Promise<void>,
): Promise<void> {
  const lines: string[] = [];
  const runtime = createQueueRuntime({
    entry: 'api',
    db: f.db,
    logger: createRootLogger(
      { entry: 'api', appEnv: 'test', level: 'warn' },
      {
        write: (line) => {
          lines.push(line);
        },
      },
    ),
  });
  await runtime.start();
  try {
    await run(runtime);
  } finally {
    await runtime.stop();
  }
}

// ---------------------------------------------------------------------------------------------
// The real worker entry with a recording JOB_QUEUE.

export interface RecordedSend {
  readonly queue: string;
  readonly name: string;
  readonly payload: JobPayload;
  readonly options: SendOptions;
}

export interface Worker {
  /** Every send of the entry's JOB_QUEUE, in order. */
  readonly sent: RecordedSend[];
  /** Every pino line of the entry. */
  readonly logs: string[];
  close(): Promise<void>;
}

interface WorkerBootstrap {
  createWorkerContext(
    entry: 'worker',
    overrides: {
      readonly config: unknown;
      readonly clock: FixedClock;
      readonly logger: RootLogger;
      readonly dbHandles: DbHandles;
    },
  ): Promise<{ close(): Promise<void> }>;
}

interface PlatformRuntime {
  readonly PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
  readonly JOB_QUEUE: symbol;
  loadConfig(env: Record<string, string>): unknown;
}

const ROOT = new URL('../../../../', import.meta.url);

/**
 * Starts the worker entry (createWorkerContext: modules built, init and bootstrap hooks run) on the
 * fixture's database and clock. Its JOB_QUEUE records every send and answers a synthetic id; it is
 * never started, so no job runs.
 */
export async function startWorker(f: Fixture): Promise<Worker> {
  // Loaded by URL (as the other entry rule tests do): bootstrap and app.module pull in the Nest
  // controllers, which the `test` project does not compile.
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as WorkerBootstrap;
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as PlatformRuntime;
  const sent: RecordedSend[] = [];
  const logs: string[] = [];
  const queue = {
    async send(queueName: string, name: string, payload: JobPayload, options: SendOptions) {
      sent.push({ queue: queueName, name, payload, options });
      return `spec-${sent.length}`;
    },
    register: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const original = platform.PlatformModule.forRoot.bind(platform.PlatformModule);
  const spy = vi.spyOn(platform.PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = original(options);
    return {
      ...module,
      providers: (module.providers ?? []).map((provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === platform.JOB_QUEUE
          ? { provide: platform.JOB_QUEUE, useValue: queue }
          : provider,
      ),
    };
  });
  const db: Kysely<DB> = f.db;
  try {
    const context = await boot.createWorkerContext('worker', {
      config: platform.loadConfig({ APP_ENV: 'test' }),
      clock: f.clock,
      logger: createRootLogger(
        { entry: 'worker', appEnv: 'test', level: 'info' },
        {
          write: (line) => {
            logs.push(line);
          },
        },
      ),
      dbHandles: { db, dbRead: null, close: async () => undefined },
    });
    return {
      sent,
      logs,
      async close() {
        try {
          await context.close();
        } finally {
          spy.mockRestore();
        }
      },
    };
  } catch (error) {
    spy.mockRestore();
    throw error;
  }
}

/** The worker's bill.recon sends naming the app. */
export function workerReconSends(w: Worker, appId: string): RecordedSend[] {
  return w.sent.filter((job) => job.name === BILL_RECON_JOB && job.payload['app_id'] === appId);
}
