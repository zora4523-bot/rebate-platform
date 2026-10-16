import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import {
  CatalogConfigReader,
  CatalogModule,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { CATALOG } from '../../../../apps/api/src/modules/catalog/catalog.module.ts';
import type { PlatformRecord } from '../../../../apps/api/src/modules/catalog/domain/types.ts';
import { CatalogDetailService } from '../../../../apps/api/src/modules/catalog/application/detail-service.ts';
import type { ProductDetailData } from '../../../../apps/api/src/modules/catalog/detail.ts';
import * as trendReader from '../../../../apps/api/src/modules/catalog/price-trend/read.ts';
import * as trendStore from '../../../../apps/api/src/modules/catalog/price-trend/store.ts';
import type {
  PriceTrendRow,
  PriceTrendStore,
} from '../../../../apps/api/src/modules/catalog/price-trend/types.ts';
import type { TokenService } from '../../../../apps/api/src/modules/identity/application/access-tokens.ts';
import { TOKEN_SERVICE } from '../../../../apps/api/src/modules/identity/application/tokens.ts';
import {
  FixedClock,
  DB,
  createRootLogger,
  loadConfig,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import type { HttpApp, Response } from '../search-route/http-kit.ts';

const root = new URL('../../../../', import.meta.url);
const originalCatalogModule = CatalogModule.forRoot;

// Dictionary prefixes from db/migrations/0017_catalog-baseline.sql; eleme has no product key.
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

export const headers = {
  'x-app-id': 'synthetic_trend',
  'x-platform': 'ios',
  'x-app-version': '1.2.3',
  'x-device-id': '01920000-0000-7000-8000-00000000d001',
  'x-trace-id': '01920000-0000-7000-8000-00000000d029',
};

export const detailCard: ProductDetailData = {
  product_key: 'tb:route001',
  item_ref: 'synthetic-reference',
  platform: 'taobao',
  title: '合成详情商品',
  image: null,
  price_fen: 3990,
  coupon_fen: 1000,
  final_price_fen: 2990,
  est_net_price_fen: null,
  rebate_min_fen: 100,
  rebate_max_fen: 200,
  rebate_basis: 'normal',
  benefit_tags: [],
  is_presale: false,
  link_id: '01920000-0000-7000-8000-000000000029',
  cta: { text_key: 'btn.buy.coupon' },
  quoted_at: '2026-10-17T12:00:00+08:00',
  stale: false,
  age_sec: 0,
  source: 'taobao_union',
  disclaimer_keys: ['price_basis'],
  availability: 'ok',
};

interface RouteApp extends HttpApp {
  get<T>(provider: symbol): T;
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

export function snapshotRows(couponFen = 0n): PriceTrendRow[] {
  return [
    {
      sourceKind: 'detail',
      couponFen,
      finalPriceFen: 3290n,
      firstObservedAt: new Date('2026-10-16T02:00:00.000Z'),
      lastObservedAt: new Date('2026-10-16T02:00:00.000Z'),
    },
    {
      sourceKind: 'detail',
      couponFen,
      finalPriceFen: 2990n,
      firstObservedAt: new Date('2026-10-17T02:00:00.000Z'),
      lastObservedAt: new Date('2026-10-17T02:00:00.000Z'),
    },
  ];
}

/** Keep the real app, request checks, controller and B1-29a reader. Replace the existing store
 * factory and configuration port, and inject a FixedClock. The DB sentinel lives only inside
 * CatalogModule and has no I/O methods; unrelated modules still start without a DB handle.
 */
export async function fixture() {
  const clock = new FixedClock('2026-10-17T04:00:00.000Z');
  const rows = vi.fn<PriceTrendStore['rows']>(async () => snapshotRows());
  const keyStability = vi.fn<PriceTrendStore['keyStability']>(async () => 'stable_7d');
  const configValue = vi.fn<CatalogConfigReader['configValue']>(async () => ({
    value: 2,
    version: 1,
  }));
  const store = { rows, keyStability };
  vi.spyOn(trendStore, 'createKyselyPriceTrendStore').mockReturnValue(store);
  const read = vi.spyOn(trendReader, 'getPriceTrend');
  const database: { withSchema(): unknown } = { withSchema: () => database };
  const detail = vi.fn<CatalogDetailService['get']>(async () => ({ ...detailCard }));
  vi.spyOn(CatalogModule, 'forRoot').mockImplementation((...args) => {
    const module = originalCatalogModule(...args);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []).map((provider) => {
          if (typeof provider !== 'object') return provider;
          if (provider.provide === CatalogDetailService)
            return { provide: CatalogDetailService, useValue: { get: detail } };
          if (provider.provide === CatalogConfigReader)
            return { provide: CatalogConfigReader, useValue: { configValue } };
          if (provider.provide === CATALOG)
            return { provide: CATALOG, useValue: { listPlatforms: async () => platforms } };
          return provider;
        }),
        { provide: DB, useValue: database },
      ],
    };
  });
  const overrides = {
    config: loadConfig({ APP_ENV: 'test' }),
    clock,
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  };
  // As in search-route/http-kit.ts, dynamic import keeps Nest bootstrap out of test's TS build.
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp(entry: 'api', options: typeof overrides): Promise<RouteApp>;
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
    throw error;
  }
  return {
    app,
    routes,
    rows,
    keyStability,
    configValue,
    read,
    detail,
    clock,
    request(productKey = 'tb:route001', query = 'platform=taobao', extraHeaders = {}) {
      return app.inject({
        method: 'GET',
        url: `/v1/products/${encodeURIComponent(productKey)}/price-trend?${query}`,
        headers: { ...headers, ...extraHeaders },
      });
    },
    async memberAuthorization() {
      const service = app.get<TokenService>(TOKEN_SERVICE);
      const credential = await service.issueAccess({
        uid: '01920000-0000-7000-8000-000000000011',
        app_id: 'synthetic_trend',
        sid: 'synthetic-session',
        device_id: '01920000-0000-7000-8000-00000000d001',
        scp: 'full',
      });
      return `Bearer ${credential}`;
    },
  };
}

interface Contract {
  components: { schemas: Record<string, JsonSchema> };
  paths: Record<string, { get?: Record<string, unknown> }>;
}

export async function contract(): Promise<Contract> {
  const requireApi = createRequire(new URL('apps/api/package.json', root));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<Contract>;
  };
  return parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)));
}

export async function assertContract(
  response: Response,
  name: 'ProductPriceTrendResponse' | 'ProductResponse' | 'ErrorEnvelope',
): Promise<void> {
  const schema = (await contract()).components.schemas[name];
  expect(schema).toBeDefined();
  const validate = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
}
