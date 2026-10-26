// B2-15n rule-test kit (claude-independent, SPEC_REF 736d24c5; 08 BR-PAY-07「每日 T+1 用渠道的交易账单…逐笔
// 核对」「差错单…告警」; B2-15m money review r1 / r2 S2 留项: every new process restarted each App's chain at
// its first bill day, a day reconciled again alerted its known diffs again, a chain catching up fanned
// out over the pay queue's slots).
// Real pieces: the worker entry (bootstrap.createWorkerContext on the fixture's database and clock)
// and the handler it registers on queue pay, so bill.recon runs over payment's own wiring of ledger
// (posting, recon diff registration and the ledger export that tells a new diff from a known one —
// its name, like the name of payment's record of reconciled bill days, is the implementation's),
// content's configuration and the clock; the seed of the daily chain (application/
// pay-recon-schedule.ts seedBillRecon, what the worker runs after bootstrap and on every heal),
// called without a memory of started Apps as a new process calls it; PostgreSQL through
// @couli/db/testing as couli_app. Synthetic: the channel bills (../recon/kit.ts BillChannel, handed
// to the worker's channel set through PayChannelSet.of) and the JOB_QUEUE, a recorder that is never
// started (every send recorded; a hook may observe a send or refuse it first).
// The worker context is closed as soon as its handler is taken: its seed timer never fires, and the
// handler keeps the fixture's database, clock and the recorder. A new worker is a new process: no
// state of the previous one's module graph is reused. Missing pieces fail as assertions.
// Plain SQL always names the schema.
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import { PayChannelSet } from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
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
  type RootLogger,
  type SendOptions,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { received, warnings, type SentJob } from '../result/kit.ts';
import { settled, shape, vouchersLike, type Recon } from '../recon/kit.ts';
import { AT_ONCE_SECONDS, BILL_RECON_JOB, PAY_QUEUE, billDateOf } from '../recon-schedule/kit.ts';

/** The seed's options (the worker's memory of started Apps). */
type SeedOptions = Parameters<typeof seedBillRecon>[1];

/** Called with every send before it is recorded; throwing refuses the send (nothing recorded). */
export type SendHook = (job: SentJob) => Promise<void>;

export interface PayWorker {
  /** Every send that went through, in order (the handler's and the seed's). */
  readonly sent: SentJob[];
  /** Every pino line of the worker and of the seed. */
  readonly logs: string[];
  /** One bill.recon job of `payload` through the worker's handler of queue pay; how it ended. */
  run(payload: JobPayload): Promise<string>;
  /** The seed of the daily chain; without `started` it is a new process's seed. */
  seed(started?: Map<string, string>): Promise<void>;
  /** Gives PayChannelSet.of back (call when done with the worker). */
  release(): void;
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
 * A worker process over the Recon's database, clock and bill channels (see the header): the handler
 * of queue pay it registered, and the seed over the same recording queue.
 */
export async function payWorker(r: Recon, beforeSend?: SendHook): Promise<PayWorker> {
  // Loaded by URL (as the other entry rule tests do): bootstrap and app.module pull in the Nest
  // controllers, which the `test` project does not compile.
  const boot = (await import(new URL('apps/api/src/bootstrap.ts', ROOT).href)) as WorkerBootstrap;
  const platform = (await import(
    new URL('apps/api/src/modules/platform/index.ts', ROOT).href
  )) as PlatformRuntime;
  const sent: SentJob[] = [];
  const logs: string[] = [];
  const handlers = new Map<string, JobHandler>();
  const queue = {
    async send(queueName: string, name: string, payload: JobPayload, options: SendOptions) {
      const job: SentJob = {
        queue: queueName,
        name,
        payload,
        options,
        inTransaction: options.trx !== null && options.trx.isTransaction,
      };
      if (beforeSend !== undefined) await beforeSend(job);
      sent.push(job);
      return `spec-${sent.length}`;
    },
    register(queueName: string, handler: JobHandler) {
      handlers.set(queueName, handler);
    },
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const logger = createRootLogger(
    { entry: 'worker', appEnv: 'test', level: 'info' },
    {
      write: (line) => {
        logs.push(line);
      },
    },
  );
  const original = platform.PlatformModule.forRoot.bind(platform.PlatformModule);
  const rootSpy = vi.spyOn(platform.PlatformModule, 'forRoot').mockImplementation((options) => {
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
  const channelSpy = vi.spyOn(PayChannelSet.prototype, 'of');
  channelSpy.mockImplementation((channel: PayChannelCode) => r.channels[channel]);
  const db: Kysely<DB> = r.f.db;
  try {
    const context = await boot.createWorkerContext('worker', {
      config: platform.loadConfig({ APP_ENV: 'test' }),
      clock: r.f.clock,
      logger,
      dbHandles: { db, dbRead: null, close: async () => undefined },
    });
    await context.close();
  } catch (error) {
    channelSpy.mockRestore();
    throw error;
  } finally {
    rootSpy.mockRestore();
  }
  const handler = handlers.get(PAY_QUEUE);
  expect(handler, 'the worker registered the handler of queue pay').toBeDefined();
  return {
    sent,
    logs,
    run: (payload) => settled(handler!(received(BILL_RECON_JOB, payload))),
    async seed(started) {
      // The seed's deps are a subset of the handler's (db, clock, queue, logger).
      const deps = { db, clock: r.f.clock, queue, logger } as unknown as PayReconSeedDeps;
      const options = (started === undefined ? {} : { started }) as unknown as SeedOptions;
      await seedBillRecon(deps, options);
    },
    release() {
      channelSpy.mockRestore();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Reading the recorded sends.

/** The daily bill.recon sends (no pay_channel) of the app among `jobs`, in send order. */
export function daily(jobs: readonly SentJob[], appId: string): SentJob[] {
  return jobs.filter(
    (job) =>
      job.name === BILL_RECON_JOB &&
      job.payload['app_id'] === appId &&
      job.payload['pay_channel'] === undefined,
  );
}

/** Due at once: at most AT_ONCE_SECONDS of delay. */
export function dueAtOnce(job: SentJob): boolean {
  return (job.options.delaySeconds ?? 0) <= AT_ONCE_SECONDS;
}

export interface Ran {
  readonly billDate: string;
  /** 'resolved' or the error (../recon/kit.ts settled). */
  readonly outcome: string;
}

/**
 * Runs the daily run of `first`, then, as the worker would, the next daily run each run enqueued
 * while it is due at once and of a bill day not run yet, at most `limit` runs in all.
 */
export async function drain(
  w: PayWorker,
  appId: string,
  first: JobPayload,
  limit: number,
): Promise<Ran[]> {
  const ran: Ran[] = [];
  let payload: JobPayload | null = first;
  while (payload !== null && ran.length < limit) {
    const billDate = String(payload['bill_date']);
    const from = w.sent.length;
    const outcome = await w.run(payload);
    ran.push({ billDate, outcome });
    const next = daily(w.sent.slice(from), appId).at(-1);
    payload =
      next !== undefined &&
      dueAtOnce(next) &&
      !ran.some((done) => done.billDate === billDateOf(next))
        ? next.payload
        : null;
  }
  return ran;
}

// ---------------------------------------------------------------------------------------------
// Readers.

/** The PAY_FEE vouchers of the app as uniq key, kind and entries. */
export async function feeShapes(r: Recon) {
  return (await vouchersLike(r, 'PAY_FEE:')).map(shape);
}

/** The uniq keys of the app's PAY_FEE vouchers as `handle` sees them (a send's transaction or not). */
export async function feeKeys(handle: Kysely<DB>, appId: string): Promise<string[]> {
  const result = await sql<{ uniq_key: string }>`
    SELECT uniq_key FROM app.ledger_vouchers
    WHERE app_id = ${appId} AND starts_with(uniq_key, 'PAY_FEE:')
    ORDER BY uniq_key`.execute(handle);
  return result.rows.map((row) => row.uniq_key);
}

/** The pay_recon_mismatch alerts (warn or above) that name `refId`. */
export function mismatchAlerts(logs: readonly string[], refId: string): Record<string, unknown>[] {
  return warnings(logs, 'pay_recon_mismatch').filter((entry) =>
    JSON.stringify(entry).includes(refId),
  );
}
