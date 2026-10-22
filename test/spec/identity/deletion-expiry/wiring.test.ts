// B1-15f: assembly (brief §9.2 #1 装配: a worker module of identity exported through index.ts; no
// database → the token provides null and one info line; IdentityWorkerModule.forWorker gets no new
// required option; rule-test list item 11 「只 worker 装配、无库 token 为 null」). The module is built
// from the options app.module really passes (captured on the worker entry, option names not read),
// inside a harness that only offers the platform tokens. A compile-only Kysely records the SQL a
// round would send; nothing connects.
import { afterEach, expect, it, vi } from 'vitest';
import {
  ROOT,
  capturedWorkerOptions,
  compileOnlyDb,
  identity,
  ports,
  workerHarness,
} from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

it('[AC-B1-15f#28] AppModule 只在 worker 入口装配 IdentityDeletionExpiryModule，其他入口不装', async () => {
  const api = await identity();
  const p = await ports();
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): unknown };
  };
  const forWorker = vi
    .spyOn(api.IdentityDeletionExpiryModule, 'forWorker')
    .mockReturnValue({ module: api.IdentityDeletionExpiryModule });
  AppModule.forEntry({
    entry: 'worker',
    config: p.platform.loadConfig({ APP_ENV: 'test' }),
    clock: p.clock,
    logger: p.logger,
  });
  expect(forWorker).toHaveBeenCalledTimes(1);
  for (const entry of ['api', 'stream', 'admin', 'payout']) {
    AppModule.forEntry({
      entry,
      config: p.platform.loadConfig({ APP_ENV: 'test' }),
      clock: p.clock,
      logger: p.logger,
    });
  }
  expect(forWorker).toHaveBeenCalledTimes(1);
});

it('[AC-B1-15f#29] worker 无数据库：token 提供 null、一行 info，不读库、无控制器', async () => {
  const api = await identity();
  const p = await ports();
  const options = await capturedWorkerOptions(api, p);
  const module = api.IdentityDeletionExpiryModule.forWorker(options as never);
  expect(module.controllers ?? []).toEqual([]);
  p.lines.length = 0;
  const context = await workerHarness(p, module, 'test');
  try {
    expect(api.deletionExpiryToken()).toBe(api.deletionExpiryToken());
    expect(context.get(api.deletionExpiryToken())).toBeNull();
    expect(p.logs().filter((line) => line['level'] === 30)).toHaveLength(1);
    expect(p.logs().filter((line) => Number(line['level']) >= 40)).toEqual([]);
  } finally {
    await context.close();
  }
}, 30_000);

it.each(['test', 'local', 'staging', 'prod'] as const)(
  '[AC-B1-15f#30] %s 环境 worker 有库：token 是可运行的到期任务，一轮扫描只读 deletion_requests、不加锁',
  async (appEnv) => {
    const api = await identity();
    const p = await ports();
    const options = await capturedWorkerOptions(api, p);
    const module = api.IdentityDeletionExpiryModule.forWorker(options as never);
    p.lines.length = 0;
    const queries: string[] = [];
    const db = compileOnlyDb(queries);
    const context = await workerHarness(p, module, appEnv, db);
    try {
      const runner = context.get(api.deletionExpiryToken()) as {
        runOnce(): Promise<{ scanned: number }>;
      };
      expect(runner).toMatchObject({ runOnce: expect.any(Function) });
      expect(queries).toEqual([]);
      expect(await runner.runOnce()).toEqual({ scanned: 0 });
      expect(queries.length).toBeGreaterThanOrEqual(1);
      for (const query of queries) {
        expect(query).toMatch(/^select /i);
        expect(query).not.toMatch(/for update|for no key update|for share|advisory/i);
      }
      expect(queries.some((query) => query.includes('"deletion_requests"'))).toBe(true);
    } finally {
      try {
        await context.close();
      } finally {
        await db.destroy();
      }
    }
  },
  30_000,
);
