import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { DB } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { createScan, job, ports, type Job, type Options, type Scan } from './kit.ts';

const databases: Kysely<DB>[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

function emptyDatabase() {
  // Real query compilation, empty results, no socket or database. Selection rules live in scans.int.
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  databases.push(db);
  return db;
}

async function emptyScan() {
  const p = await ports();
  const db = emptyDatabase();
  const writes = vi.fn(async () => undefined);
  const options: Options = { ...p, db, riskState: { setRiskState: writes } };
  const service = await createScan(options);
  return { ...p, db, options, service, writes };
}

it('[AC-B1-03j#22] AppModule 只给 worker 装配 risk-scan handler，队列启动后投两类种子', async () => {
  const scanModule = (await import(
    new URL('../../../../apps/api/src/modules/risk/application/risk-scan.ts', import.meta.url).href
  )) as { createRiskScan(options: Options): Scan };
  const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: {
      createApplicationContext(
        module: unknown,
        options: object,
      ): Promise<{ close(): Promise<void> }>;
    };
  };
  const { AppModule } = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { AppModule: { forEntry(options: object): unknown } };
  const { PlatformModule, JOB_QUEUE, loadConfig } = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as {
    PlatformModule: {
      forRoot(options: object): { providers?: unknown[] };
    };
    JOB_QUEUE: symbol;
    loadConfig(env: Record<string, string>): unknown;
  };
  for (const entry of ['worker', 'api', 'stream', 'admin', 'payout']) {
    const p = await ports();
    const db = emptyDatabase();
    let running = false;
    const send = vi.fn<Options['queue']['send']>(async () => {
      // Production QueueRuntime rejects sends until start() has finished.
      if (!running) throw new Error('fixture-queue-not-running');
      return 'fixture-seed';
    });
    const register = vi.fn<(queue: string, handler: (job: Job) => Promise<void>) => void>();
    const queue = {
      send,
      register,
      async start() {
        running = true;
      },
      async stop() {
        running = false;
      },
    };
    const start = queue.start;
    // Observe the actual assembled service; seed() remains an explicit caller responsibility.
    const scanFactory = vi.spyOn(scanModule, 'createRiskScan');
    const original = PlatformModule.forRoot.bind(PlatformModule);
    const spy = vi.spyOn(PlatformModule, 'forRoot').mockImplementation((options) => {
      const module = original(options);
      return {
        ...module,
        providers: (module.providers ?? []).map((provider) =>
          typeof provider === 'object' &&
          provider !== null &&
          'provide' in provider &&
          provider.provide === JOB_QUEUE
            ? { provide: JOB_QUEUE, useValue: queue }
            : provider,
        ),
      };
    });
    let context: { close(): Promise<void> } | undefined;
    try {
      context = await NestFactory.createApplicationContext(
        AppModule.forEntry({
          entry,
          config: loadConfig({ APP_ENV: 'test' }),
          clock: p.clock,
          logger: p.logger,
          dbHandles: { db, dbRead: null, close: async () => undefined },
        }),
        { logger: false, abortOnError: false },
      );
      const handlers = register.mock.calls.filter(([name]) => name === 'risk-scan');
      expect(handlers).toHaveLength(entry === 'worker' ? 1 : 0);
      expect(send).not.toHaveBeenCalled();
      expect(queue.start).toBe(start);
      await queue.start();
      expect(send).not.toHaveBeenCalled();
      if (entry === 'worker') {
        expect(scanFactory).toHaveBeenCalledTimes(1);
        const result = scanFactory.mock.results[0]!;
        expect(result.type).toBe('return');
        await result.value.seed();
      }
      const seeds = send.mock.calls.filter(([name]) => name === 'risk-scan');
      expect(seeds.map(([, name]) => name).sort()).toEqual(
        entry === 'worker' ? ['daily-alerts', 'freeze-expiry'] : [],
      );
      if (entry === 'worker') {
        for (const [name, singletonKey] of [
          ['freeze-expiry', 'freeze-expiry:2026-10-14T16:00'],
          ['daily-alerts', 'daily-alerts:2026-10-15'],
        ]) {
          expect(send).toHaveBeenCalledWith(
            'risk-scan',
            name,
            {},
            expect.objectContaining({ trx: null, singletonKey }),
          );
        }
        send.mockClear();
        await handlers[0]![1](job('freeze-expiry'));
        expect(send).toHaveBeenCalledExactlyOnceWith(
          'risk-scan',
          'freeze-expiry',
          {},
          expect.objectContaining({ singletonKey: 'freeze-expiry:2026-10-14T16:01' }),
        );
      }
    } finally {
      await context?.close();
      spy.mockRestore();
      scanFactory.mockRestore();
    }
  }
}, 30_000);

it('[AC-B1-03j#12] risk-scan 队列为 exclusive，只由 worker 单并发消费', async () => {
  const { QUEUE_CATALOG, ENTRY_PLAN } = (await import(
    new URL('../../../../apps/api/src/modules/platform/queue/catalog.ts', import.meta.url).href
  )) as {
    QUEUE_CATALOG: { name: string; policy: string }[];
    ENTRY_PLAN: Record<string, { queue: string; concurrency: number }[]>;
  };
  expect(QUEUE_CATALOG.filter((q) => q.name === 'risk-scan')).toEqual([
    expect.objectContaining({ name: 'risk-scan', policy: 'exclusive' }),
  ]);
  expect(ENTRY_PLAN['worker']!.filter((w) => w.queue === 'risk-scan')).toEqual([
    expect.objectContaining({ queue: 'risk-scan', concurrency: 1 }),
  ]);
  for (const entry of ['api', 'stream', 'admin', 'payout']) {
    expect(ENTRY_PLAN[entry]!.filter((w) => w.queue === 'risk-scan')).toEqual([]);
  }
});

it('[AC-B1-03j#13] 启动按 UTC 分钟和 +08 日期投两类种子，同槽重复启动保持相同 key', async () => {
  const f = await emptyScan();
  f.clock.set('2026-10-15T00:00:23+08:00');
  await f.service.seed();
  expect(f.send).toHaveBeenCalledTimes(2);
  for (const [name, singletonKey] of [
    ['freeze-expiry', 'freeze-expiry:2026-10-14T16:00'],
    ['daily-alerts', 'daily-alerts:2026-10-15'],
  ]) {
    expect(f.send).toHaveBeenCalledWith(
      'risk-scan',
      name,
      {},
      expect.objectContaining({ trx: null, singletonKey }),
    );
  }
  const keys = f.send.mock.calls.map(([, name, , options]) => [name, options.singletonKey]);
  f.send.mockClear();
  // null means the queue already holds this key; duplicates must not change the key to bypass it.
  f.send.mockResolvedValue(null);
  f.clock.advanceMs(10_000);
  await f.service.seed();
  expect(f.send.mock.calls.map(([, name, , options]) => [name, options.singletonKey])).toEqual(
    keys,
  );
});

for (const [now, minute, delay] of [
  ['2026-10-15T00:00:00+08:00', '2026-10-14T16:01', 60],
  ['2026-10-15T00:00:23+08:00', '2026-10-14T16:01', 37],
  ['2026-10-15T00:00:59.999+08:00', '2026-10-14T16:01', 1],
  ['2026-12-31T23:59:59+00:00', '2027-01-01T00:00', 1],
] as const) {
  it(`[AC-B1-03j#14] ${now} 完成到期扫描，按下一 UTC 分钟续投，延迟 ${delay} 秒`, async () => {
    const f = await emptyScan();
    f.clock.set(now);
    await f.service.handle(job('freeze-expiry'));
    expect(f.send).toHaveBeenCalledExactlyOnceWith(
      'risk-scan',
      'freeze-expiry',
      {},
      expect.objectContaining({
        trx: null,
        singletonKey: `freeze-expiry:${minute}`,
        delaySeconds: delay,
      }),
    );
    expect(f.writes).not.toHaveBeenCalled();
  });
}

for (const [now, day, delay] of [
  ['2026-10-15T00:00:00+08:00', '2026-10-16', 86700],
  ['2026-10-15T00:04:59+08:00', '2026-10-16', 86401],
  ['2026-10-15T00:05:00+08:00', '2026-10-16', 86400],
  ['2026-10-15T23:59:59+08:00', '2026-10-16', 301],
  ['2026-12-31T23:59:59+08:00', '2027-01-01', 301],
] as const) {
  it(`[AC-B1-03j#15] daily-alerts 在 ${now} 完成，续投距下一个 +08:00 自然日 00:05 的 ${delay} 秒`, async () => {
    const f = await emptyScan();
    f.clock.set(now);
    await f.service.handle(job('daily-alerts'));
    expect(f.send).toHaveBeenCalledExactlyOnceWith(
      'risk-scan',
      'daily-alerts',
      {},
      expect.objectContaining({
        trx: null,
        singletonKey: `daily-alerts:${day}`,
        delaySeconds: delay,
      }),
    );
  });
}

it('[AC-B1-03j#19] 跨 +08 午夜重新启动：种子使用新 UTC 分钟、新本地日期', async () => {
  const f = await emptyScan();
  f.clock.set('2026-12-31T23:59:59+08:00');
  await f.service.seed();
  f.clock.advanceMs(1_000);
  await f.service.seed();
  expect(f.send.mock.calls.map(([, , , options]) => options.singletonKey).sort()).toEqual([
    'daily-alerts:2026-12-31',
    'daily-alerts:2027-01-01',
    'freeze-expiry:2026-12-31T15:59',
    'freeze-expiry:2026-12-31T16:00',
  ]);
  for (const [, , , options] of f.send.mock.calls) {
    expect(options.delaySeconds ?? 0).toBe(0);
  }
});

for (const [name, currentKey, nextKey, nextTime] of [
  [
    'freeze-expiry',
    'freeze-expiry:2026-10-14T16:00',
    'freeze-expiry:2026-10-14T16:01',
    '2026-10-15T00:01:00+08:00',
  ],
  [
    'daily-alerts',
    'daily-alerts:2026-10-15',
    'daily-alerts:2026-10-16',
    '2026-10-16T00:05:00+08:00',
  ],
] as const) {
  it(`[AC-B1-03j#20] ${name} 当前任务仍 active 时能投下一槽；重复 worker 与下一槽启动种子不会分叉`, async () => {
    const f = await emptyScan();
    const peer = await createScan(f.options);
    // Model exclusive's queued + active key ownership, not only queued-job de-duplication.
    const occupied = new Set<string>([currentKey]);
    const accepted: string[] = [];
    f.send.mockImplementation(async (queue, task, payload, options) => {
      expect(queue).toBe('risk-scan');
      expect(payload).toEqual({});
      expect(options.singletonKey).toBeDefined();
      const key = options.singletonKey!;
      if (occupied.has(key)) return null;
      occupied.add(key);
      if (task === name) accepted.push(key);
      return `fixture-${occupied.size}`;
    });
    await Promise.all([f.service.handle(job(name)), peer.handle(job(name))]);
    expect(occupied.has(currentKey)).toBe(true);
    expect(accepted).toEqual([nextKey]);
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls.every(([, , , options]) => options.singletonKey === nextKey)).toBe(
      true,
    );
    f.clock.set(nextTime);
    await peer.seed();
    expect(accepted).toEqual([nextKey]);
  });
}

it('[AC-B1-03j#21] 扫描跨分钟完成，按完成时 Clock 选择未来时间槽，不补投已经过去的分钟', async () => {
  const f = await emptyScan();
  f.clock.set('2026-10-15T00:00:50+08:00');
  const delayed = f.db.withPlugin({
    transformQuery(args) {
      f.clock.set('2026-10-15T00:02:17+08:00');
      return args.node;
    },
    async transformResult(args) {
      return args.result;
    },
  });
  const service = await createScan({ ...f.options, db: delayed });
  await service.handle(job('freeze-expiry'));
  expect(f.send).toHaveBeenCalledExactlyOnceWith(
    'risk-scan',
    'freeze-expiry',
    {},
    expect.objectContaining({
      trx: null,
      singletonKey: 'freeze-expiry:2026-10-14T16:03',
      delaySeconds: 43,
    }),
  );
});

for (const name of ['freeze-expiry', 'daily-alerts'] as const) {
  it(`[AC-B1-03j#16] ${name} 扫描失败交队列重试，不再投一条任务链`, async () => {
    const f = await emptyScan();
    const failed = f.db.withPlugin({
      transformQuery() {
        throw new Error('fixture-scan-failed');
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const service = await createScan({ ...f.options, db: failed });
    await expect(service.handle(job(name))).rejects.toThrow('fixture-scan-failed');
    expect(f.send).not.toHaveBeenCalled();
  });

  it(`[AC-B1-03j#17] ${name} 续投失败记录 warn，当前成功扫描仍返回成功`, async () => {
    const f = await emptyScan();
    f.send.mockRejectedValue(new Error('fixture-enqueue-failed'));
    await expect(f.service.handle(job(name))).resolves.toBeUndefined();
    expect(f.send).toHaveBeenCalledTimes(1);
    const lines = f.lines.map((line) => JSON.parse(line) as { level: number });
    expect(lines.some((line) => line.level === 40)).toBe(true);
  });
}
