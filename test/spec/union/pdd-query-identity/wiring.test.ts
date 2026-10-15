import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../apps/api/src/modules/platform/config/config.ts';
import type {
  CallCtx,
  UnionEndpoint,
} from '../../../../apps/api/src/modules/union/domain/types.ts';
import * as http from '../../../../apps/api/src/modules/union/infra/http-transport.ts';
import * as pdd from '../../../../apps/api/src/modules/union/infra/pdd/pdd-adapter.ts';
import type { PddWarning } from '../../../../apps/api/src/modules/union/infra/pdd/response.ts';
import type { UnionRegistry } from '../../../../apps/api/src/modules/union/infra/registry.ts';
import type { UnionTransport } from '../../../../apps/api/src/modules/union/infra/replay.ts';
import { ctx, envelope, row, search } from '../pdd-goods/kit.ts';
import { clock, configured, endpoints, startUnion } from '../pdd-live-wiring/kit.ts';
import { APP, OTHER_APP, CUSTOM, VARIABLE, candidate, outcome, pidDatabase } from './kit.ts';

// Credentials are an already-tested startup boundary (B1-04t). Never open a credential file.
vi.mock('../../../../apps/api/src/modules/platform/config/pdd-startup.ts', async (original) => ({
  ...(await original<
    typeof import('../../../../apps/api/src/modules/platform/config/pdd-startup.ts')
  >()),
  openPddCredentials: vi.fn(async () => async () => ({
    clientId: 'synthetic-client',
    clientSecret: 'fake-key',
  })),
}));

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => expect.fail('network access is forbidden')),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

interface FactoryProvider {
  provide: unknown;
  inject?: readonly unknown[];
  useFactory?: (...args: unknown[]) => unknown;
}
interface ModuleMetadata {
  module: unknown;
  providers: FactoryProvider[];
  exports?: unknown[];
}
interface ModuleExports {
  UNION_ENDPOINTS: unknown;
  UNION_REGISTRY: unknown;
  UnionModule: { forRoot(): ModuleMetadata };
}
interface TestContext {
  get<T>(token: unknown): T;
  init(): Promise<unknown>;
  close(): Promise<void>;
}
interface NestTesting {
  Test: {
    createTestingModule(metadata: { imports: unknown[] }): {
      compile(): Promise<TestContext>;
    };
  };
}

function configuration(value: string | null | undefined = CUSTOM): AppConfig {
  const base = configured('synthetic-unused-file');
  return { ...base, ...(value === undefined ? {} : { pddQueryCustomParameters: value }) };
}

function observe() {
  const Original = pdd.PddUnionAdapter;
  return vi.spyOn(pdd, 'PddUnionAdapter').mockImplementation(class extends Original {});
}

function fakeTransport() {
  const requests: Record<string, unknown>[] = [];
  const transport = vi.fn<UnionTransport>(async (request) => {
    const body = JSON.parse(request.body!) as Record<string, unknown>;
    requests.push(body);
    return { status: 200, headers: {}, body: JSON.stringify(envelope(body.type, [row()])) };
  });
  vi.spyOn(http, 'createUnionHttpTransport').mockReturnValue(transport);
  return { transport, requests };
}

/** Full Nest dependency resolution without starting an application or listening on a port. */
async function assemble(
  config: AppConfig,
  database?: ReturnType<typeof pidDatabase>,
  configuredEndpoints: readonly UnionEndpoint[] = endpoints(),
) {
  const union = (await import(
    new URL('../../../../apps/api/src/modules/union/union.module.ts', import.meta.url).href
  )) as ModuleExports;
  const platform = (await import(
    new URL('../../../../apps/api/src/modules/platform/index.ts', import.meta.url).href
  )) as Record<string, unknown>;
  const requireApi = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
  const testing = (await import(
    pathToFileURL(requireApi.resolve('@nestjs/testing')).href
  )) as NestTesting;
  const warn = vi.fn();
  const logger = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => logger };
  const values = new Map<unknown, unknown>([
    [platform['APP_CONFIG'], config],
    [platform['CLOCK'], clock],
    [platform['ROOT_LOGGER'], logger],
  ]);
  // Main DB handle: this is a SELECT-only use case, not the reporting-only DB_READ replica.
  if (database) values.set(platform['DB'], database.db);
  class FixtureGlobals {}
  const metadata = union.UnionModule.forRoot();
  const registryFactory = metadata.providers.find((p) => p.provide === union.UNION_REGISTRY);
  expect(registryFactory?.inject).toEqual([
    union.UNION_ENDPOINTS,
    platform['APP_CONFIG'],
    platform['CLOCK'],
    platform['ROOT_LOGGER'],
  ]);
  const result = await outcome(() =>
    testing.Test.createTestingModule({
      imports: [
        {
          module: FixtureGlobals,
          global: true,
          providers: [...values].map(([provide, useValue]) => ({ provide, useValue })),
          exports: [...values.keys()],
        },
        {
          ...metadata,
          providers: metadata.providers.map((provider) =>
            provider.provide === union.UNION_ENDPOINTS
              ? { provide: provider.provide, useValue: configuredEndpoints }
              : provider,
          ),
        },
      ],
    }).compile(),
  );
  expect(result).not.toBeInstanceOf(Error);
  const context = result as TestContext;
  const initialized = await outcome(() => context.init());
  expect(initialized).not.toBeInstanceOf(Error);
  return { context, registry: context.get<UnionRegistry>(union.UNION_REGISTRY), warn };
}

it('[AC-B1-04x-WIRING#1] Nest 装配真实适配器：按当前 app 读查询位、原样带配置、每次重新读取', async () => {
  const database = pidDatabase([
    candidate(),
    candidate({ app_id: OTHER_APP, pid: 'other-query-pid' }),
  ]);
  const { requests } = fakeTransport();
  vi.stubEnv(VARIABLE, '{"uid":"ambient-forgery"}');
  const { context, registry, warn } = await assemble(configuration(), database);
  try {
    const adapter = registry.get('pdd');
    for (const [appId, pid] of [
      [APP, 'synthetic-query-pid'],
      [OTHER_APP, 'other-query-pid'],
    ] as const) {
      const result = await outcome(() =>
        adapter.searchItems(
          { keyword: '合成商品' },
          {
            ...ctx,
            appId,
            headers: { pid: 'forged-pid', uid: 'forged-uid' },
          },
        ),
      );
      expect(result).not.toBeInstanceOf(Error);
      expect(requests.at(-1)).toMatchObject({ pid, custom_parameters: CUSTOM });
    }
    database.replace([candidate({ pid: 'replacement-query-pid' })]);
    const replaced = await outcome(() =>
      adapter.searchItems({ keyword: '合成商品' }, { ...ctx, appId: APP }),
    );
    expect(replaced).not.toBeInstanceOf(Error);
    expect(requests.at(-1)).toMatchObject({
      pid: 'replacement-query-pid',
      custom_parameters: CUSTOM,
    });
    expect(database.statements).toHaveLength(3);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    await context.close();
    await database.db.destroy();
  }
});

it('[AC-B1-04x-WIRING#2] 缺少当前 app 的 active 查询位时 upstream_rejected，不能借用其他场景或 app', async () => {
  const database = pidDatabase([
    candidate({ app_id: OTHER_APP }),
    candidate({ pid_scene: 'self_buy' }),
    candidate({ pid_scene: 'fallback' }),
    candidate({ status: 'retired' }),
  ]);
  const { transport } = fakeTransport();
  const { context, registry } = await assemble(configuration(), database);
  try {
    const result = await outcome(() =>
      registry.get('pdd').searchItems({ keyword: '合成商品' }, { ...ctx, appId: APP }),
    );
    expect(database.statements).toHaveLength(1);
    expect(result).toMatchObject({ code: 'upstream_rejected', platform: 'pdd' });
    expect(transport).not.toHaveBeenCalled();
  } finally {
    await context.close();
    await database.db.destroy();
  }
});

it('[AC-B1-04x-WIRING#3] 已装配的提供者只读取 ctx.appId，不读取 headers 或其他上下文字段', async () => {
  const database = pidDatabase();
  const observed = observe();
  fakeTransport();
  const { context } = await assemble(configuration(), database);
  try {
    const options = observed.mock.calls[0]?.[0];
    expect(options?.queryIdentity).toBeTypeOf('function');
    const queryIdentity = options!.queryIdentity as (ctx: CallCtx) => Promise<pdd.PddQueryIdentity>;
    const reads: PropertyKey[] = [];
    const guarded = new Proxy(
      { ...ctx, appId: APP },
      {
        get(target, key, receiver) {
          reads.push(key);
          expect(key).toBe('appId');
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );
    const result = await outcome(() => queryIdentity(guarded));
    expect(result).toEqual({ pid: 'synthetic-query-pid', customParameters: CUSTOM });
    expect(reads).toContain('appId');
  } finally {
    await context.close();
    await database.db.destroy();
  }
});

it.each([null, 'absent'] as const)(
  '[AC-B1-04x-STARTUP#1] live 缺查询配置（%s）仍启动，只告警变量名一次，商品调用拒绝',
  async (missing) => {
    const { transport } = fakeTransport();
    const config = missing === null ? configuration(null) : configured('synthetic-unused-file');
    const logs: string[] = [];
    // Frozen B1-04t harness supplies exactly four factory dependencies and no DB.
    const result = await outcome(() => startUnion(config, endpoints(), logs));
    expect(result).not.toBeInstanceOf(Error);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(VARIABLE);
    expect(logs.join('\n')).not.toMatch(/synthetic-unused-file|FAKE_PDD_CLIENT_ID|fake-key/);
    const failure = await outcome(() =>
      (result as UnionRegistry).get('pdd').searchItems({ keyword: '合成商品' }, ctx),
    );
    expect(failure).toMatchObject({ code: 'upstream_rejected', platform: 'pdd' });
    expect(logs).toHaveLength(1);
    expect(transport).not.toHaveBeenCalled();
    const quiet: string[] = [];
    await startUnion(config, endpoints('demo'), quiet);
    expect(quiet).toEqual([]);
  },
);

it('[AC-B1-04x-STARTUP#2] 可选数据库缺席不阻止启动，已装配身份提供者让商品调用安全拒绝', async () => {
  const observed = observe();
  const { transport } = fakeTransport();
  const { context, registry } = await assemble(configuration());
  try {
    expect(observed.mock.calls[0]?.[0].queryIdentity).toBeTypeOf('function');
    const failure = await outcome(() =>
      registry.get('pdd').searchItems({ keyword: '合成商品' }, ctx),
    );
    expect(failure).toMatchObject({ code: 'upstream_rejected', platform: 'pdd' });
    expect(transport).not.toHaveBeenCalled();
  } finally {
    await context.close();
  }
});

it('[AC-B1-04x-STARTUP#3] live 已有当前 app 的 active 查询位但缺配置：启动仅告警变量名一次，商品调用拒绝', async () => {
  const database = pidDatabase();
  const { transport } = fakeTransport();
  const { context, registry, warn } = await assemble(configuration(null), database);
  try {
    expect(warn).toHaveBeenCalledTimes(1);
    // Accept a plain message or flat pino fields; every logged value is only the variable name.
    const loggedValues = warn.mock.calls[0]!.flatMap((value: unknown) =>
      value !== null && typeof value === 'object' ? Object.values(value) : [value],
    );
    expect(new Set(loggedValues)).toEqual(new Set([VARIABLE]));
    const failure = await outcome(() =>
      registry.get('pdd').searchItems({ keyword: '合成商品' }, { ...ctx, appId: APP }),
    );
    expect(failure).toMatchObject({ code: 'upstream_rejected', platform: 'pdd' });
    expect(transport).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    await context.close();
    await database.db.destroy();
  }
});

it('[AC-B1-04x-LOG#1] event 优先：价格异常不记未知错误码、不携带金额；无 event 保留错误码告警', async () => {
  const observed = observe();
  fakeTransport();
  const { context, warn } = await assemble(configuration());
  try {
    const hook = observed.mock.calls[0]?.[0].warn;
    expect(hook).toBeTypeOf('function');
    const event: PddWarning & { amount_fen: number; custom_parameters: string } = {
      event: 'PRICE_ANOMALY',
      error_code: 'PRICE_ANOMALY',
      type: search,
      amount_fen: 876543,
      custom_parameters: CUSTOM,
    };
    hook!(event);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ event: 'PRICE_ANOMALY' });
    const fields = warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(
      Object.keys(fields).every((key) => ['event', 'method', 'type', 'error_code'].includes(key)),
    ).toBe(true);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /876543|synthetic-query-user|PDD_ERROR_CODE_UNKNOWN/,
    );
    hook!({ error_code: 'synthetic-unknown-code', type: search });
    expect(warn.mock.calls[1]?.[0]).toEqual({
      event: 'PDD_ERROR_CODE_UNKNOWN',
      error_code: 'synthetic-unknown-code',
      method: search,
    });
  } finally {
    await context.close();
  }
});
