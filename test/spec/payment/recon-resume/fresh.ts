// B2-15n rule-test kit, second part (claude-independent, SPEC_REF 736d24c5; rule-test review r1 S2 on
// ./kit.ts: its workers share the test file's module graph, so a memory kept at module level in
// payment — reconciled days, alerted diffs — would carry over from one worker to the next and pass
// for persisted). freshWorker is ./kit.ts payWorker as a process of its own: vi.resetModules() first,
// then the worker entry (bootstrap), platform, payment's channel set and the seed of the daily
// chain are loaded afresh, so the worker's handler and seed run on a module graph no earlier worker
// touched; what a previous worker left can only reach it through PostgreSQL. A worker built before
// keeps its own graph and stays usable (two processes side by side). The channel bills, the
// recording JOB_QUEUE and the fixture's database and clock are handed in as in ./kit.ts.
// A test file that builds a fresh worker builds every worker through this kit: ./kit.ts payWorker
// after a reset would spy on a channel set the new graph does not use.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, vi } from 'vitest';
import type { PayChannelSet } from '../../../../apps/api/src/modules/payment/application/pay-channel.ts';
import type {
  PayReconSeedDeps,
  seedBillRecon,
} from '../../../../apps/api/src/modules/payment/application/pay-recon-schedule.ts';
import type { PayChannelCode } from '../../../../apps/api/src/modules/payment/domain/types.ts';
import type {
  createRootLogger,
  DbHandles,
  FixedClock,
  JobHandler,
  JobPayload,
  RootLogger,
  SendOptions,
} from '../../../../apps/api/src/modules/platform/index.ts';
import { settled, type Recon } from '../recon/kit.ts';
import { received, type SentJob } from '../result/kit.ts';
import { BILL_RECON_JOB, PAY_QUEUE } from '../recon-schedule/kit.ts';
import type { PayWorker, SendHook } from './kit.ts';

type SeedOptions = Parameters<typeof seedBillRecon>[1];

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
  readonly createRootLogger: typeof createRootLogger;
}

const ROOT = new URL('../../../../', import.meta.url);

function load(path: string): Promise<unknown> {
  return import(new URL(path, ROOT).href);
}

/**
 * A worker process on a module graph of its own (see the header) over the Recon's database, clock
 * and bill channels: the handler of queue pay it registered, and its seed, on one recording queue.
 */
export async function freshWorker(r: Recon, beforeSend?: SendHook): Promise<PayWorker> {
  vi.resetModules();
  // Loaded by URL (as ./kit.ts): bootstrap and app.module pull in the Nest controllers, which the
  // `test` project does not compile.
  const boot = (await load('apps/api/src/bootstrap.ts')) as WorkerBootstrap;
  const platform = (await load('apps/api/src/modules/platform/index.ts')) as PlatformRuntime;
  const channelSet = (await load('apps/api/src/modules/payment/application/pay-channel.ts')) as {
    readonly PayChannelSet: typeof PayChannelSet;
  };
  const schedule = (await load(
    'apps/api/src/modules/payment/application/pay-recon-schedule.ts',
  )) as { readonly seedBillRecon: typeof seedBillRecon };
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
  const logger = platform.createRootLogger(
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
  const channelSpy = vi.spyOn(channelSet.PayChannelSet.prototype, 'of');
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
      await schedule.seedBillRecon(deps, options);
    },
    release() {
      channelSpy.mockRestore();
    },
  };
}
