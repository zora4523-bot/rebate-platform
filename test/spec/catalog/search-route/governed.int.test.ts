import { randomUUID } from 'node:crypto';
import { createDb, destroyDb, type DB } from '@couli/db';
import {
  acquireTestRedis,
  createTestDatabase,
  type TestDatabase,
  type TestRedis,
} from '@couli/db/testing';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as catalog from '../../../../apps/api/src/modules/catalog/index.ts';
import type { SearchProductsData } from '../../../../apps/api/src/modules/catalog/search.ts';
import {
  FixedClock,
  createRootLogger,
  loadConfig,
  loadConnectionConfig,
  type ConnectionConfig,
  type DbHandles,
} from '../../../../apps/api/src/modules/platform/index.ts';
import * as union from '../../../../apps/api/src/modules/union/index.ts';
import { assertContract, headers, type HttpApp } from './http-kit.ts';

const root = new URL('../../../../', import.meta.url);
const clock = new FixedClock('2026-10-07T12:00:00+08:00');
// 独立 app 范围使共享测试 Redis 上也没有旧搜索缓存；不清空 Redis。
const appId = `synthetic_gov_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
const logger = createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
let database: TestDatabase | undefined;
let redis: TestRedis | undefined;
let db: Kysely<DB> | undefined;
let app: HttpApp | undefined;

beforeAll(async () => {
  database = await createTestDatabase();
  db = createDb({ connectionString: database.urlFor('couli_app'), max: 4 }).withSchema('app');
  redis = await acquireTestRedis();
  await db
    .updateTable('platforms')
    .set({ search_support: 'supported', key_stability: 'stable_24h', updated_at: clock.now() })
    .where('code', '=', 'taobao')
    .execute();
  await db
    .insertInto('config_items')
    .values([
      {
        app_id: appId,
        key: 'search.enabled.taobao',
        value: true,
        updated_by: 'synthetic-governed-fixture',
      },
      {
        app_id: appId,
        key: 'tech_fee_bp',
        value: { taobao: 0, jd: 0, pdd: 0 },
        updated_by: 'synthetic-governed-fixture',
      },
      {
        app_id: appId,
        key: 'rebate.taobao.compare_rate_ratio_bp',
        value: 5000,
        updated_by: 'synthetic-governed-fixture',
      },
    ])
    .execute();
  const accountId = randomUUID();
  await db
    .insertInto('union_accounts')
    .values({
      id: accountId,
      app_id: appId,
      platform: 'taobao',
      account_name: 'synthetic-governed-account',
      status: 'active',
      auth_status: 'active',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  await db
    .insertInto('union_pids')
    .values({
      id: randomUUID(),
      app_id: appId,
      platform: 'taobao',
      union_account_id: accountId,
      site_id: 'synthetic-query-site',
      pid: 'synthetic-query-pid',
      pid_scene: 'query',
      status: 'active',
      hjy_ignore_confirmed_at: clock.now(),
      hjy_ignore_evidence_path: 'https://example.test/synthetic-governed-evidence',
      created_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
}, 180_000);

afterAll(async () => {
  try {
    await app?.close();
  } finally {
    try {
      if (db !== undefined) await destroyDb(db);
    } finally {
      try {
        await database?.drop();
      } finally {
        try {
          await redis?.stop();
        } finally {
          vi.restoreAllMocks();
        }
      }
    }
  }
});

it('[AC-B1-05j#20] 真实 AppModule 的 HTTP 搜索经联盟治理包装调用上游', async () => {
  // 仅观察：三个 spy 均默认调用原实现，不替换提供者、上游、报价或存储。
  // 同时核对工厂收到的适配器实例与实际 searchItems 的 this，并检查治理层注入的
  // signal/baseUrl/headers：裸适配器没有治理工厂调用或这些调用上下文，因断言而红；
  // 即使创建了包装却仍走裸适配器，也不能仅凭工厂调用通过本用例。
  const governed = vi.spyOn(union, 'createGovernedAdapter');
  const upstream = vi.spyOn(union.DemoUnionAdapter.prototype, 'searchItems');
  const quotes = vi.spyOn(catalog, 'createDemoRebateQuoter');

  // 与 e2e 用例一致，经动态导入使用真实 AppModule，装饰器由 API 项目编译。
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp: (
      entry: 'api',
      overrides: {
        config: ReturnType<typeof loadConfig>;
        clock: FixedClock;
        logger: typeof logger;
        dbHandles: DbHandles;
        redisUrl: ConnectionConfig['redisUrl'];
      },
    ) => Promise<HttpApp>;
  };
  const connection = loadConnectionConfig('api', {
    DATABASE_URL: database!.urlFor('couli_app'),
    REDIS_URL: redis!.url,
  });
  app = await createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock,
    logger,
    dbHandles: { db: db!, dbRead: null, close: async () => undefined },
    redisUrl: connection.redisUrl,
  });
  await app.init();
  expect(quotes).toHaveBeenCalled();
  // 跟随真实装配选择的演示报价配置名，不在规则测试中发明业务配置名。
  await db!
    .insertInto('config_items')
    .values({
      app_id: appId,
      key: quotes.mock.calls[0]![0].ruleConfigKey,
      value: { reserve_bp: 0, self_share_bp: 10000 },
      updated_by: 'synthetic-governed-fixture',
    })
    .execute();

  upstream.mockClear();
  const query = new URLSearchParams({ platform: 'taobao', q: '演示商品', limit: '2' });
  const response = await app.inject({
    method: 'GET',
    url: `/v1/products/search?${query}`,
    headers: { ...headers, 'x-app-id': appId },
  });
  expect(response.statusCode).toBe(200);
  await assertContract(response, true);
  const body = response.json<{ code: number; data: SearchProductsData }>();
  expect(body.code).toBe(0);
  expect(body.data.items).toHaveLength(2);
  expect(upstream).toHaveBeenCalled();
  expect(governed).toHaveBeenCalled();

  for (const [index, [request, context]] of upstream.mock.calls.entries()) {
    expect(request.keyword).toBe('演示商品');
    const wrapping = governed.mock.calls.find(
      ([adapter]) => adapter === upstream.mock.contexts[index],
    );
    expect(wrapping, 'HTTP 实际调用的适配器必须经治理工厂包装').toBeDefined();
    expect(wrapping![1].endpoint).toMatchObject({ platform: 'taobao', mode: 'demo' });
    expect(context).toMatchObject({
      appId,
      purpose: 'online',
      signal: expect.any(AbortSignal),
      baseUrl: wrapping![1].endpoint.baseUrl,
      headers: {},
    });
    expect(context.signal?.aborted).toBe(false);
  }
}, 60_000);
