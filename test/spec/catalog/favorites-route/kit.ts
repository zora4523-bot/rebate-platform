import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import {
  CATALOG,
  CatalogConfigReader,
  CatalogDetailService,
  CatalogModule,
  type FavoritesService,
  type PlatformRecord,
  type ProductDetailData,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import * as favoritesFactory from '../../../../apps/api/src/modules/catalog/favorites/service.ts';
import * as sessionsFactory from '../../../../apps/api/src/modules/identity/infra/session-lookup.ts';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { TOKEN_SERVICE } from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import {
  DB,
  IDEMPOTENCY,
  FixedClock,
  PlatformModule,
  createIdempotency,
  createRootLogger,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { idempotencyStorage } from './storage.ts';

const root = new URL('../../../../', import.meta.url);
const originalCatalog = CatalogModule.forRoot;
const originalPlatform = PlatformModule.forRoot;
export const headers = {
  'x-app-id': 'synthetic_favorites',
  'x-platform': 'ios',
  'x-app-version': '1.2.3',
  'x-channel': 'appstore',
  'x-device-id': '01920000-0000-7000-8000-00000000d001',
  'x-trace-id': '01920000-0000-7000-8000-00000000d028',
};
export const favoritePath = '/v1/me/favorites/taobao/tb%3Afavorite001';
export const batchBody = {
  items: [
    { platform: 'taobao', product_key: 'tb:favorite001' },
    { platform: 'jd', product_key: 'jd:favorite002' },
  ],
};
export const writes = [
  { method: 'PUT', url: favoritePath },
  { method: 'DELETE', url: favoritePath },
  { method: 'POST', url: '/v1/me/favorites/batch-delete', payload: batchBody },
] as const;
export const operations = [
  { method: 'GET', path: '/v1/me/favorites', id: 'listFavorites', schema: 'FavoriteListResponse' },
  {
    method: 'PUT',
    path: '/v1/me/favorites/{platform}/{product_key}',
    id: 'addFavorite',
    schema: 'FavoriteResponse',
  },
  {
    method: 'DELETE',
    path: '/v1/me/favorites/{platform}/{product_key}',
    id: 'removeFavorite',
    schema: 'EmptyResponse',
  },
  {
    method: 'POST',
    path: '/v1/me/favorites/batch-delete',
    id: 'batchDeleteFavorites',
    schema: 'EmptyResponse',
  },
] as const;

const platforms: PlatformRecord[] = [
  ['taobao', 'tb'],
  ['jd', 'jd'],
  ['pdd', 'pdd'],
  ['meituan', 'mt'],
  ['vip', 'vip'],
  ['douyin', 'dy'],
  ['eleme', null],
  ['kuaishou', 'ks'],
  ['suning', 'sn'],
].map(([code, prefix]) => ({
  code: code!,
  key_prefix: prefix ?? null,
  key_stability: 'stable_7d',
  search_support: 'supported',
  convert_support: 'supported',
  order_sync_support: 'supported',
  stage: 'm_beta',
}));

export const detailCard: ProductDetailData = {
  product_key: 'tb:favorite001',
  item_ref: 'synthetic-reference',
  platform: 'taobao',
  title: '合成收藏商品',
  image: 'https://img.example.test/favorite.jpg',
  price_fen: 3990,
  coupon_fen: 1000,
  final_price_fen: 2990,
  est_net_price_fen: 2790,
  rebate_min_fen: 200,
  rebate_max_fen: 200,
  rebate_basis: 'normal',
  benefit_tags: [],
  is_presale: false,
  link_id: '01920000-0000-7000-8000-000000000028',
  cta: { text_key: 'btn.buy.coupon' },
  quoted_at: '2030-10-17T04:00:00.000Z',
  stale: false,
  age_sec: 0,
  source: 'taobao_union',
  disclaimer_keys: ['price_basis'],
  availability: 'ok',
};

export interface Response {
  statusCode: number;
  headers: Record<string, unknown>;
  json<T = unknown>(): T;
}
export interface Request {
  method: 'GET' | 'PUT' | 'DELETE' | 'POST';
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
}
interface App {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  get<T>(provider: symbol): T;
  inject(request: Request): Promise<Response>;
  getHttpServer(): { listening: boolean };
  getHttpAdapter(): {
    getInstance(): {
      addHook(
        name: 'onRoute',
        callback: (route: { method: string | string[]; url: string }) => void,
      ): void;
      ready(): Promise<unknown>;
    };
  };
}

/** Real api bootstrap, JWT verification, identity context, contract validation and idempotency.
 * Only use cases, active-session lookup, version reader and PG wire storage are stand-ins.
 * No future controller imports: on the baseline, requests fail assertions with HTTP 404. */
export async function fixture() {
  const clock = new FixedClock('2030-10-17T04:00:00.000Z');
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'warn', entry: 'api', appEnv: 'test' },
    {
      write: (line) => {
        lines.push(line);
      },
    },
  );
  const storage = idempotencyStorage();
  const idempotency = createIdempotency({ db: storage.db, clock, logger });
  vi.spyOn(PlatformModule, 'forRoot').mockImplementation((options) => {
    const module = originalPlatform(options);
    return {
      ...module,
      providers: [...(module.providers ?? []), { provide: IDEMPOTENCY, useValue: idempotency }],
      exports: [...(module.exports ?? []), IDEMPOTENCY],
    };
  });
  const activeSessions = new Set<string>();
  vi.spyOn(sessionsFactory, 'createSessionLookup').mockReturnValue({
    find: async (appId, sid) =>
      activeSessions.has(`${appId}/${sid}`) ? { revoked_at: null } : null,
  });
  // Dynamic import keeps Nest-only decorators out of the rule-test TypeScript project.
  const { RiskModule } = (await import(
    new URL('apps/api/src/modules/risk/risk.module.ts', root).href
  )) as {
    RiskModule: { forRoot(options: Record<string, unknown>): Record<string, unknown> };
  };
  const originalRisk = RiskModule.forRoot;
  vi.spyOn(RiskModule, 'forRoot').mockImplementation((options) =>
    originalRisk({
      ...options,
      minimumVersions: {
        useFactory: () => ({
          pooled: { minSupportedVersion: async () => null },
          on: () => ({ minSupportedVersion: async () => null }),
        }),
      },
    }),
  );

  const service = {
    addFavorite: vi.fn<FavoritesService['addFavorite']>(
      async (_app, _user, platform, productKey) => ({
        id: '01920000-0000-7000-8000-000000000028',
        platform,
        productKey,
        favoritedAt: new Date('2030-10-01T01:30:00.000Z'),
      }),
    ),
    removeFavorite: vi.fn<FavoritesService['removeFavorite']>(async () => undefined),
    removeFavorites: vi.fn<FavoritesService['removeFavorites']>(async () => undefined),
    listFavorites: vi.fn<FavoritesService['listFavorites']>(async () => ({
      items: [],
      nextCursor: null,
    })),
    isFavorited: vi.fn<FavoritesService['isFavorited']>(async () => false),
    deleteAllFavoritesOfUser: vi.fn<FavoritesService['deleteAllFavoritesOfUser']>(
      async () => undefined,
    ),
  };
  vi.spyOn(favoritesFactory, 'createFavoritesService').mockReturnValue(service);
  const detail = vi.fn<CatalogDetailService['get']>(async () => ({ ...detailCard }));
  vi.spyOn(CatalogModule, 'forRoot').mockImplementation((...args) => {
    const module = originalCatalog(...args);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []).map((provider) => {
          if (typeof provider !== 'object') return provider;
          if (provider.provide === CatalogDetailService)
            return { provide: CatalogDetailService, useValue: { get: detail } };
          if (provider.provide === CatalogConfigReader)
            return {
              provide: CatalogConfigReader,
              useValue: { configValue: async () => ({ value: 500, version: 1 }) },
            };
          if (provider.provide === CATALOG)
            return { provide: CATALOG, useValue: { listPlatforms: async () => platforms } };
          return provider;
        }),
        // Local to CatalogModule: unrelated modules remain in their no-database test mode.
        { provide: DB, useValue: storage.db },
      ],
    };
  });
  const overrides = { clock, logger, config: loadConfig({ APP_ENV: 'test' }) };
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp(entry: 'api', options: typeof overrides): Promise<App>;
  };
  const app = await createHttpApp('api', overrides);
  const routes: string[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) routes.push(`${method} ${route.url}`);
    });
  try {
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  } catch (error) {
    await app.close();
    await storage.db.destroy();
    throw error;
  }
  return {
    app,
    routes,
    service,
    detail,
    clock,
    lines,
    async close() {
      try {
        await app.close();
      } finally {
        await storage.db.destroy();
      }
    },
    request(request: Request, authorization?: string, key: string | null = 'favorite-key-0001') {
      return app.inject({
        ...request,
        headers: {
          ...headers,
          ...(authorization === undefined ? {} : { authorization }),
          ...(key === null ? {} : { 'idempotency-key': key }),
          ...request.headers,
        },
      });
    },
    async memberAuthorization(
      uid = '01920000-0000-7000-8000-000000000011',
      appId = 'synthetic_favorites',
    ) {
      const sid = `synthetic-session-${uid}`;
      activeSessions.add(`${appId}/${sid}`);
      const credential = await app.get<TokenService>(TOKEN_SERVICE).issueAccess({
        uid,
        app_id: appId,
        sid,
        device_id: '01920000-0000-7000-8000-00000000d001',
        scp: 'full',
      });
      return `Bearer ${credential}`;
    },
  };
}

interface Contract {
  components: { schemas: Record<string, JsonSchema> };
  paths: Record<string, Record<string, Record<string, unknown>>>;
}
let document: Promise<Contract> | undefined;
export function contract(): Promise<Contract> {
  const requireApi = createRequire(new URL('apps/api/package.json', root));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string, options: object): Promise<Contract>;
  };
  return (document ??= parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)), {
    resolve: { external: false },
  }));
}

export async function assertContract(response: Response, name: string): Promise<void> {
  const schema = (await contract()).components.schemas[name];
  expect(schema).toBeDefined();
  const validate = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
}
