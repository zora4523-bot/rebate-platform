// B3-03h 第 9 节 8：模块装配（照 test/spec/risk/freeze-expiry/scheduling.test.ts：真 Nest 上下文、只编译不连库的
// Kysely）。AppModule.forEntry({entry: 'worker'}) 含 AgentModule.forWorker 提供的 agentSweeperToken()；有库时
// 是运行体（runTimingsDefaults、sweeperDefaults、agentSweepLoopDefaults，T14 assertRunTimings 成立，文案取自
// contracts/texts.default.json），装配时不发查询、不起循环；无库时为 null 且恰一条 info agent_sweeper_disabled；
// 其他四个入口没有这个 token。
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

import {
  assertRunTimings,
  runTimingsDefaults,
} from '../../../../apps/api/src/modules/agent/stream/pg/index.ts';
import { sweeperDefaults } from '../../../../apps/api/src/modules/agent/stream/sweeper/index.ts';
import { agentSweepLoopDefaults } from '../../../../apps/api/src/modules/agent/stream/sweeper/loop.ts';
import {
  AgentModule,
  agentSweeperToken,
  type AgentSweeperRuntime,
} from '../../../../apps/api/src/modules/agent/index.ts';
import { ports } from '../../risk/freeze-expiry/kit.ts';
import { LEVEL, fileErrorMsg } from './kit.ts';

const databases: Kysely<DB>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(databases.splice(0).map((db) => db.destroy()));
});

function compileOnlyDb(queries: string[]): Kysely<DB> {
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(event) {
      queries.push(event.query.sql);
    },
  });
  databases.push(db);
  return db;
}

interface Context {
  get(token: unknown, options?: { strict: boolean }): unknown;
  close(): Promise<void>;
}

async function contextOf(entry: string, withDb: boolean) {
  // Loaded by URL (as the B1-03j scheduling test does): app.module pulls in the Nest controllers,
  // which the `test` project does not compile.
  const { AppModule } = (await import(
    new URL('../../../../apps/api/src/app.module.ts', import.meta.url).href
  )) as { AppModule: { forEntry(options: object): unknown } };
  const { PlatformModule, JOB_QUEUE, loadConfig } = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as {
    PlatformModule: { forRoot(options: object): { providers?: unknown[] } };
    JOB_QUEUE: symbol;
    loadConfig(env: Record<string, string>): unknown;
  };
  const apiRequire = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const { NestFactory } = (await import(
    pathToFileURL(apiRequire.resolve('@nestjs/core')).href
  )) as {
    NestFactory: { createApplicationContext(module: unknown, options: object): Promise<Context> };
  };
  const p = await ports();
  const queries: string[] = [];
  const queue = {
    send: vi.fn(async () => 'fixture'),
    register: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const original = PlatformModule.forRoot.bind(PlatformModule);
  vi.spyOn(PlatformModule, 'forRoot').mockImplementation((options) => {
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
  const context = await NestFactory.createApplicationContext(
    AppModule.forEntry({
      entry,
      config: loadConfig({ APP_ENV: 'test' }),
      clock: p.clock,
      logger: p.logger,
      // No handles at all = a worker without a database (PlatformModule then provides no DB).
      ...(withDb
        ? {
            dbHandles: {
              db: compileOnlyDb(queries),
              dbRead: null,
              close: async () => undefined,
            },
          }
        : {}),
    }),
    { logger: false, abortOnError: false },
  );
  const lines = () => p.lines.map((line) => JSON.parse(line) as { level: number; msg: string });
  return { context, queries, queue, lines };
}

it('[AC-B3-03h#26] worker 入口（有库）：agentSweeperToken() 提供运行体；参数为 runTimingsDefaults / sweeperDefaults / agentSweepLoopDefaults，assertRunTimings 成立；装配不发查询、不调队列', async () => {
  const { context, queries, queue, lines } = await contextOf('worker', true);
  try {
    const runtime = context.get(agentSweeperToken(), { strict: false }) as AgentSweeperRuntime;
    expect(runtime).not.toBeNull();
    expect(typeof runtime.start).toBe('function');
    expect(typeof runtime.step.sweepOnce).toBe('function');
    expect(runtime.timings).toEqual(runTimingsDefaults());
    expect(runtime.sweeperConfig).toEqual(sweeperDefaults());
    expect(runtime.loopConfig).toEqual({
      ...agentSweepLoopDefaults(),
      maxPerTick: sweeperDefaults().maxPerTick,
    });
    expect(() =>
      assertRunTimings({
        ...runtime.timings,
        admissionRunMaxMs: runtime.timings.runMaxMs,
        sweepMarginMs: runtime.sweeperConfig.marginMs,
      }),
    ).not.toThrow();
    expect(queries.filter((q) => /advisory|agent_sessions|agent_runs/.test(q))).toEqual([]);
    expect(queue.send).not.toHaveBeenCalled();
    expect(queue.register.mock.calls.map(([name]) => name)).not.toContain('agent-sweep');
    expect(lines().filter((l) => l.msg === 'agent_sweeper_disabled')).toEqual([]);
    // One process-wide runtime.
    expect(context.get(agentSweeperToken(), { strict: false })).toBe(runtime);
  } finally {
    await context.close();
  }
});

it('[AC-B3-03h#27] 运行体的 texts.errorMsg 取 contracts/texts.default.json 的 error.<code>（变量缺失时写法优先、缺键回落 error.50001），不含占位符', async () => {
  const { context } = await contextOf('worker', true);
  try {
    const runtime = context.get(agentSweeperToken(), { strict: false }) as AgentSweeperRuntime;
    for (const code of [50001, 30506, 50401]) {
      expect(runtime.texts.errorMsg(code), String(code)).toBe(fileErrorMsg(code));
      expect(runtime.texts.errorMsg(code), String(code)).not.toMatch(/\{[a-z_0-9]+\}/);
    }
    expect(runtime.texts.errorMsg(99_999)).toBe(fileErrorMsg(50001));
  } finally {
    await context.close();
  }
});

it('[AC-B3-03h#28] worker 入口没有库：token 提供 null，恰一条 info agent_sweeper_disabled', async () => {
  const { context, lines } = await contextOf('worker', false);
  try {
    expect(context.get(agentSweeperToken(), { strict: false })).toBeNull();
    const disabled = lines().filter((l) => l.msg === 'agent_sweeper_disabled');
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.level).toBe(LEVEL.info);
  } finally {
    await context.close();
  }
});

it('[AC-B3-03h#29] api / stream / admin / payout 入口不装 AgentModule.forWorker：没有该 token、也不记 agent_sweeper_disabled', async () => {
  const token = agentSweeperToken();
  for (const entry of ['api', 'stream', 'admin', 'payout']) {
    const { context, lines } = await contextOf(entry, true);
    try {
      expect(() => context.get(token, { strict: false }), entry).toThrow();
      expect(
        lines().filter((l) => l.msg === 'agent_sweeper_disabled'),
        entry,
      ).toEqual([]);
    } finally {
      await context.close();
    }
    vi.restoreAllMocks();
  }
});

it('[AC-B3-03h#30] AgentModule.forWorker() 提供并导出 agentSweeperToken()（同一个 symbol）', () => {
  const token = agentSweeperToken();
  expect(typeof token).toBe('symbol');
  expect(agentSweeperToken()).toBe(token);
  const module = AgentModule.forWorker();
  expect(module.module).toBe(AgentModule);
  expect(module.exports).toContain(token);
  expect(
    (module.providers ?? []).some(
      (p) => typeof p === 'object' && p !== null && 'provide' in p && p.provide === token,
    ),
  ).toBe(true);
});
