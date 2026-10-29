// B1-05m fixtures: search hot words and keyword shortcuts (规划/01 F-PROD-03; contracts/openapi.yaml
// getSearchHotWords, SearchHotWordsData, SearchHotWord, SearchKeywordRoute, RouteTarget; BR-ATTR-29
// ①; 编排裁定 D10-419 (a)). Every value is a literal written from those texts, never read from the
// implementation:
// - the two configuration keys (B1-05l) and the switch external_page.union_host_block (default on,
//   only a stored false turns it off — the reading of the existing ExternalPage save checks);
// - route names and params come from contracts/routes.json, read here as data (routesTable);
// - specs/link-patterns.yaml has no real domains yet (B1-07), so union domains are synthetic
//   (*.test): two union_host rules, a product rule inside one of them and a promo host outside
//   them (promo is not used by ① — BR-ATTR-29「promo … 不用于 ①②」);
// - contract limits the stored values must keep, since the read returns them as configured:
//   at most 10 hot words of 1–20 characters, at most 50 shortcuts with keywords of 1–20 characters.
// The read route reads configuration only through catalog's CatalogConfigReader port (ports.ts:
// 「later catalog tasks read configuration only through it」); the HTTP fixture replaces that port.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import {
  CatalogConfigReader,
  CatalogModule,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import type { SearchConfigCheckContext } from '../../../../apps/api/src/modules/catalog/hot-words/index.ts';
import {
  DB,
  FixedClock,
  createRootLogger,
  loadConfig,
  type LinkPatternsSpec,
} from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';

const root = new URL('../../../../', import.meta.url);

export const HOT_WORDS = 'search.hot_words';
export const KEYWORD_ROUTES = 'search.keyword_routes';
export const UNION_HOST_BLOCK = 'external_page.union_host_block';
export const PATH = '/v1/search/hot-words';
export const OPERATION_ID = 'getSearchHotWords';

/** Synthetic link pattern table (no real domain is assumed). */
export const LINK_PATTERNS: LinkPatternsSpec = {
  version: 'b105m-synthetic',
  rules: [
    {
      platform: 'taobao',
      category: 'union_host',
      hosts: ['union-a.test', 'union-tm.test'],
      path_patterns: [],
    },
    { platform: 'jd', category: 'union_host', hosts: ['union-b.test'], path_patterns: [] },
    {
      platform: 'taobao',
      category: 'product',
      hosts: ['item.union-a.test'],
      path_patterns: ['/item/**'],
    },
    { platform: 'pdd', category: 'promo', hosts: ['promo.test'], path_patterns: ['/**'] },
  ],
};

export const BLOCK_ON: SearchConfigCheckContext = {
  unionHostBlock: true,
  linkPatterns: LINK_PATTERNS,
};
export const BLOCK_OFF: SearchConfigCheckContext = {
  unionHostBlock: false,
  linkPatterns: LINK_PATTERNS,
};

/** URLs on the synthetic union domains (registered domain, subdomain, case, trailing dot, port). */
export const UNION_URLS = [
  'https://union-a.test/promo',
  'https://m.union-a.test/act/1111',
  'https://M.UNION-A.TEST./x',
  'https://union-a.test:8443/x',
  'https://item.union-a.test/item/123',
  'https://union-tm.test/',
  'https://shop.union-b.test/store',
] as const;

/** https URLs outside every union domain (look-alikes, a promo host, a union host in the query). */
export const OTHER_URLS = [
  'https://brand.test/a',
  'https://notunion-a.test/',
  'https://union-a.test.brand.test/',
  'https://promo.test/x',
  'https://brand.test/go?next=https%3A%2F%2Funion-a.test%2F',
] as const;

export const external = (url: string, extra: Record<string, unknown> = {}) => ({
  route: 'ExternalPage',
  params: { url, ...extra },
});

/** A keyword shortcut. */
export const shortcut = (keyword: string, target: unknown) => ({ keyword, target });

/** A value every check accepts: one shortcut per kind of target. */
export function validRoutes() {
  return [
    shortcut('热销榜', { route: 'HotRankList', params: {} }),
    shortcut('耳机', { route: 'Search', params: { q: '蓝牙耳机', platform: 'jd' } }),
    shortcut('搜索', { route: 'Search' }),
    shortcut('爆款', {
      route: 'ProductDetail',
      params: { platform: 'taobao', product_key: 'tb:abc123' },
    }),
    shortcut('官网', external('https://brand.test/a', { title: '品牌官网', nav_style: 'dark' })),
    shortcut('订单', { route: 'OrderDetail', params: { order_id: 'o-1' } }),
  ];
}

export function validHotWords() {
  return [{ text: '蓝牙耳机' }, { text: '洗衣液' }, { text: 'iPhone 16' }];
}

/** n characters of CJK text (one UTF-16 unit each). */
export const chars = (n: number) => '热'.repeat(n);

/** n distinct hot words. */
export const manyWords = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `词${i}` }));

/** n distinct shortcuts to the hot rank. */
export const manyRoutes = (n: number) =>
  Array.from({ length: n }, (_, i) => shortcut(`词${i}`, { route: 'HotRankList' }));

// ---- contracts/routes.json ------------------------------------------------------------------

export interface RouteEntry {
  readonly debug_only?: boolean;
  readonly params: {
    readonly additionalProperties: boolean;
    readonly properties: Record<string, unknown>;
    readonly required: readonly string[];
  };
}

export function routesTable(): Record<string, RouteEntry> {
  const text = readFileSync(fileURLToPath(new URL('contracts/routes.json', root)), 'utf8');
  return (JSON.parse(text) as { routes: Record<string, RouteEntry> }).routes;
}

// ---- contract ----------------------------------------------------------------------------------

interface Contract {
  components: { schemas: Record<string, JsonSchema> };
}

let parsed: Promise<Contract> | undefined;
export function contract(): Promise<Contract> {
  const requireApi = createRequire(new URL('apps/api/package.json', root));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<Contract>;
  };
  parsed ??= parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)));
  return parsed;
}

export async function expectContract(
  body: unknown,
  name: 'SearchHotWordsResponse' | 'ErrorEnvelope',
): Promise<void> {
  const schema = (await contract()).components.schemas[name];
  expect(schema, name).toBeDefined();
  const validate = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
}

// ---- HTTP (api entry, no database) ------------------------------------------------------------

export const APP_ID = 'synthetic_hot_words';
export const TRACE_ID = '01920000-0000-7000-8000-00000000b105';

/** Anonymous basic-mode headers: no device id, no authorization. */
export const anonymous = {
  'x-app-id': APP_ID,
  'x-platform': 'android',
  'x-app-version': '1.2.3',
  'x-trace-id': TRACE_ID,
};

export interface Response {
  statusCode: number;
  headers: Record<string, unknown>;
  json<T = unknown>(): T;
}

interface RouteApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  inject(request: {
    method: 'GET';
    url: string;
    headers: Record<string, string>;
  }): Promise<Response>;
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

type Stored = Awaited<ReturnType<CatalogConfigReader['configValue']>>;
/** A stored row as the port answers it (null = no row). */
export type StoredValue = { readonly value: unknown; readonly version: number } | null;

/**
 * The real api entry (AppModule, contract request checks, the real controller) with catalog's
 * configuration port answering `values` per key (absent key = no row). The DB token is a
 * sentinel without I/O methods, as test/spec/catalog/price-trend-route/kit.ts.
 */
export async function fixture(values: Readonly<Record<string, StoredValue>> = {}) {
  const configValue = vi.fn<CatalogConfigReader['configValue']>(
    async (_appId, key) => (values[key] ?? null) as Stored,
  );
  const original = CatalogModule.forRoot;
  const database: { withSchema(): unknown } = { withSchema: () => database };
  vi.spyOn(CatalogModule, 'forRoot').mockImplementation((...args) => {
    const module = original(...args);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []).map((provider) =>
          typeof provider === 'object' && provider.provide === CatalogConfigReader
            ? { provide: CatalogConfigReader, useValue: { configValue } }
            : provider,
        ),
        { provide: DB, useValue: database },
      ],
    };
  });
  const overrides = {
    config: loadConfig({ APP_ENV: 'test' }),
    clock: new FixedClock('2030-10-17T04:00:00.000Z'),
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  };
  // Dynamic import keeps Nest bootstrap out of the rule-test project's TS build.
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
    configValue,
    request(headers: Record<string, string> = anonymous) {
      return app.inject({ method: 'GET', url: PATH, headers });
    },
  };
}

/** `<app id> <key>` of every configuration read. */
export function askedKeys(calls: ReadonlyArray<readonly [string, string]>): string[] {
  return calls.map(([appId, key]) => `${appId} ${key}`);
}
