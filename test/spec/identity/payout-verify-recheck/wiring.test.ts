import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { afterEach, expect, it, vi } from 'vitest';
import { INFLIGHT, RECHECK, ROOT, compileOnlyDb, identity, ports, workerContext } from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

async function assembled(appEnv: 'test' | 'local' | 'staging' | 'prod', withDb: boolean) {
  const api = await identity();
  const p = await ports();
  const queries: string[] = [];
  const db = compileOnlyDb(queries);
  const configValue = vi.fn(async () => ({ value: 120 }));
  const { context, module } = await workerContext(
    api,
    p,
    { configValue },
    appEnv,
    withDb ? db : undefined,
  );
  return {
    ...p,
    api,
    db,
    queries,
    configValue,
    module,
    context,
    async close() {
      try {
        await context.close();
      } finally {
        await db.destroy();
      }
    },
  };
}

it('[AC-B1-13g#30] worker 无数据库时 token 为 null，info 一次，启动不读库不建定时器', async () => {
  const f = await assembled('test', false);
  try {
    expect(f.api.payoutVerifyRecheckToken()).toBe(f.api.payoutVerifyRecheckToken());
    expect(f.context.get(f.api.payoutVerifyRecheckToken())).toBeNull();
    expect(
      f.logs().filter((line) => line['msg'] === 'payout_verify_recheck_disabled'),
    ).toHaveLength(1);
    expect(f.queries).toEqual([]);
    expect(f.configValue).not.toHaveBeenCalled();
    expect(f.module.controllers ?? []).toEqual([]);
  } finally {
    await f.close();
  }
}, 30_000);

it.each(['test', 'local', 'staging', 'prod'] as const)(
  '[AC-B1-13g#31] %s 环境 worker 可独立装配，不依赖 HTTP 身份模块和密钥服务',
  async (appEnv) => {
    const f = await assembled(appEnv, true);
    try {
      const runner = f.context.get(f.api.payoutVerifyRecheckToken()) as {
        runOnce(): Promise<{ scanned: number }>;
      };
      expect(runner).toMatchObject({ runOnce: expect.any(Function) });
      expect(f.module.controllers ?? []).toEqual([]);
      expect(f.queries).toEqual([]);
      expect(
        f.logs().filter((line) => line['msg'] === 'bank_card_verifier_unconfigured'),
      ).toHaveLength(appEnv === 'prod' || appEnv === 'staging' ? 1 : 0);
      expect(await runner.runOnce()).toEqual({ scanned: 0 });
      expect(f.queries).toHaveLength(1);
      expect(f.queries[0]).toMatch(/^select /i);
      expect(f.queries[0]).toContain('"app"."payout_account_verify_attempts"');
      expect(f.queries[0]).not.toMatch(/\*|for update|advisory|begin/i);
      expect(f.queries[0]!.split(/ from /i)[0]).toMatch(
        /^select "(?:app_id|id)", "(?:app_id|id)"$/,
      );
    } finally {
      await f.close();
    }
  },
  30_000,
);

it('[AC-B1-13g#32] AppModule 只在 worker 装 IdentityWorkerModule，并将 content 配置读口传进去', async () => {
  const api = await identity();
  const p = await ports();
  const { AppModule } = (await import(new URL('apps/api/src/app.module.ts', ROOT).href)) as {
    AppModule: { forEntry(options: object): unknown };
  };
  // Capture assembly without constructing HTTP services. Missing wiring fails an assertion.
  const forWorker = vi
    .spyOn(api.IdentityWorkerModule, 'forWorker')
    .mockReturnValue({ module: api.IdentityWorkerModule });
  const content = (await import(new URL('apps/api/src/modules/content/index.ts', ROOT).href)) as {
    createContentReader(options: { db: Kysely<DB>; clock: unknown }): unknown;
  };
  const configValue = vi.fn(async () => ({ value: 120 }));
  const reader = vi.spyOn(content, 'createContentReader').mockReturnValue({ configValue });
  const db = compileOnlyDb([]);
  try {
    AppModule.forEntry({
      entry: 'worker',
      config: p.platform.loadConfig({ APP_ENV: 'test' }),
      clock: p.clock,
      logger: p.logger,
    });
    expect(forWorker).toHaveBeenCalledTimes(1);
    const supplied = forWorker.mock.calls[0]![0].payoutAccountConfig;
    expect(supplied.inject).toContain(p.platform.CLOCK);
    const config = await supplied.useFactory(p.clock);
    await config.configValue('app-a', INFLIGHT, db);
    await config.configValue('app-b', RECHECK, db);
    expect(configValue.mock.calls).toEqual([
      ['app-a', INFLIGHT],
      ['app-b', RECHECK],
    ]);
    expect(reader).toHaveBeenLastCalledWith({ db, clock: p.clock });
    for (const entry of ['api', 'stream', 'admin', 'payout']) {
      AppModule.forEntry({
        entry,
        config: p.platform.loadConfig({ APP_ENV: 'test' }),
        clock: p.clock,
        logger: p.logger,
      });
    }
    expect(forWorker).toHaveBeenCalledTimes(1);
  } finally {
    await db.destroy();
  }
});
