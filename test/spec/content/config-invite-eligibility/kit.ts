// Isolated content HTTP assembly: real module/controller/service, fake budget port and
// in-memory config source. DummyDriver performs no I/O; no growth tables or other test kits.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { DB as Database } from '@couli/db';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type KyselyPlugin,
} from 'kysely';
import { expect, vi } from 'vitest';
import type { Schema } from '../../../../packages/contracts-ts/src/index.ts';
import type {
  ContentPublicPorts,
  InviteRewardBudgetReader,
} from '../../../../apps/api/src/modules/content/index.ts';
import {
  CachedContentReader,
  type ContentStore,
} from '../../../../apps/api/src/modules/content/application/content-reader.ts';
import {
  APP_CONFIG,
  CLOCK,
  DB,
  ROOT_LOGGER,
  FixedClock,
  createRootLogger,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

export type Config = Schema<'Config'>;
export type Values = Record<string, Database['config_items']['value']>;
export const ENABLED = 'growth.invite_reward.enabled';
export const AMOUNT = 'growth.invite_reward.amount_fen';
export const DAYS = 'growth.invite_reward.eligibility_days';
const ROOT = new URL('../../../../', import.meta.url);
const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
const REQUIRED: Values = {
  h5_base_url: 'https://h5.example.test/',
  'h5_release.stable': 'stable',
  kf: { url: 'https://kf.example.test/' },
  'legal.privacy.version': 1,
  'legal.privacy.min_version': 1,
  'legal.agreement.version': 1,
};

export interface Response {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
  json<T = unknown>(): T;
}
interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  useGlobalFilters(...filters: unknown[]): void;
  inject(input: { method: 'GET'; url: string; headers: Record<string, string> }): Promise<Response>;
}

let nextApp = 0;

export async function harness(port: 'installed' | 'omitted' | 'null' = 'installed') {
  apiRequire('reflect-metadata');
  const { ContentPublicModule } = (await import(
    new URL('apps/api/src/modules/content/index.ts', ROOT).href
  )) as { ContentPublicModule: { forApi(ports: ContentPublicPorts): unknown } };
  const { Module, Scope } = apiRequire('@nestjs/common') as {
    Module(metadata: object): (target: object) => void;
    Scope: { REQUEST: number };
  };
  const { NestFactory, REQUEST } = apiRequire('@nestjs/core') as {
    NestFactory: { create(module: unknown, adapter: unknown, options: object): Promise<HttpApp> };
    REQUEST: string;
  };
  const { PlatformFastifyAdapter, GlobalErrorFilter } = (await import(
    new URL('apps/api/src/modules/platform/http/global-errors.ts', ROOT).href
  )) as {
    PlatformFastifyAdapter: new (options: object) => {
      getInstance(): { setValidatorCompiler(compiler: unknown): void };
    };
    GlobalErrorFilter: new (adapter: unknown, logger: unknown) => unknown;
  };
  const clock = new FixedClock('2026-10-20T00:00:00Z');
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const source = new Map<string, Values>();
  const reads: { appId: string; key: string }[] = [];
  const store: ContentStore = {
    minSupportedVersionsByChannel: async () => new Map(),
    configItem: async (appId, key) => {
      reads.push({ appId, key });
      const values = source.get(appId);
      if (values === undefined || !Object.hasOwn(values, key)) return null;
      return { value: values[key]!, version: 1 };
    },
  };
  const reader = new CachedContentReader(store, clock);
  const balances = new Map<string, number | null | Error>();
  const available = vi.fn<InviteRewardBudgetReader['available']>(async (appId) => {
    const value = balances.get(appId) ?? null;
    if (value instanceof Error) throw value;
    return value;
  });
  const budget: InviteRewardBudgetReader = { available };
  const queries: string[] = [];
  const plugin: KyselyPlugin = {
    transformQuery({ node }) {
      queries.push(
        JSON.stringify(node, (_key, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        ),
      );
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  };
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (handle) => new PostgresIntrospector(handle),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [plugin],
  });
  class FixturePlatform {}
  Module({})(FixturePlatform);
  const globals = {
    module: FixturePlatform,
    global: true,
    providers: [
      { provide: DB, useValue: db },
      { provide: CLOCK, useValue: clock },
      { provide: ROOT_LOGGER, useValue: logger },
      { provide: APP_CONFIG, useValue: loadConfig({ APP_ENV: 'test' }) },
    ],
    exports: [DB, CLOCK, ROOT_LOGGER, APP_CONFIG],
  };
  const ports: ContentPublicPorts = {
    contentReader: { useFactory: () => reader },
    viewerContext: {
      scope: Scope.REQUEST,
      inject: [REQUEST],
      useFactory: (request: { headers: Record<string, string> }) => ({
        current: async () => ({ appId: request.headers['x-app-id']!, userId: null }),
      }),
    },
    ...(port === 'omitted'
      ? {}
      : { inviteRewardBudget: { useFactory: () => (port === 'null' ? null : budget) } }),
  };
  class FixtureRoot {}
  Module({ imports: [globals, ContentPublicModule.forApi(ports)] })(FixtureRoot);
  const adapter = new PlatformFastifyAdapter({ loggerInstance: logger });
  adapter.getInstance().setValidatorCompiler(createValidatorCompiler());
  let app: HttpApp | undefined;
  try {
    app = await NestFactory.create(FixtureRoot, adapter, { logger: false, abortOnError: false });
    app.useGlobalFilters(new GlobalErrorFilter(adapter, logger));
    await app.init();
    const started = app;
    return {
      app: started,
      clock,
      lines,
      reads,
      queries,
      available,
      balances,
      configured(values: Values = {}, balance: number | null | Error = 2000) {
        const id = `f102zze_${++nextApp}`;
        source.set(id, { ...REQUIRED, ...values });
        balances.set(id, balance);
        return id;
      },
      update(id: string, values: Values) {
        source.set(id, { ...source.get(id), ...values });
      },
      async close() {
        try {
          await started.close();
        } finally {
          await db.destroy();
        }
      },
    };
  } catch (error) {
    try {
      await app?.close();
    } finally {
      await db.destroy();
    }
    throw error;
  }
}
export type Harness = Awaited<ReturnType<typeof harness>>;

export function read(h: Harness, id: string, extra: Record<string, string> = {}) {
  return h.app.inject({
    method: 'GET',
    url: '/v1/config',
    headers: {
      'x-app-id': id,
      'x-platform': 'ios',
      'x-app-version': '2.0.0',
      ...extra,
    },
  });
}

type Validator = ReturnType<ReturnType<typeof createValidatorCompiler>>;
let responseValidator: Promise<Validator> | undefined;
function validator() {
  responseValidator ??= (async () => {
    const parser = apiRequire('@readme/openapi-parser') as {
      dereference(
        path: string,
        options: object,
      ): Promise<{
        paths: Record<
          string,
          {
            get: { responses: Record<string, { content: Record<string, { schema: JsonSchema }> }> };
          }
        >;
      }>;
    };
    const doc = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', ROOT)), {
      resolve: { external: false },
    });
    return createValidatorCompiler()({
      schema: doc.paths['/v1/config']!.get.responses['200']!.content['application/json']!.schema,
      httpPart: 'body',
    });
  })();
  return responseValidator;
}

export async function success(h: Harness, id: string, extra: Record<string, string> = {}) {
  const response = await read(h, id, extra);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ code: 0, data: { invite: expect.any(Object) } });
  const check = await validator();
  expect(check(response.json()), JSON.stringify(check.errors)).toBe(true);
  const data = response.json<{ data: Config }>().data;
  expect(data.invite).toHaveProperty('reward_enabled', expect.any(Boolean));
  expect(data.invite).toHaveProperty('reward_amount_fen', expect.any(Number));
  expect(response.headers['etag']).toBe(`"${data.config_version}"`);
  return { response, data };
}

export function warnings(h: Harness, start: number, appId: string) {
  return h.lines
    .slice(start)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry['level'] === 40 && entry['app_id'] === appId);
}
