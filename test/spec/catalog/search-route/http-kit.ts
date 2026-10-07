import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, vi } from 'vitest';
import {
  CatalogModule,
  ViewerContext,
  type Viewer,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { CatalogSearchService } from '../../../../apps/api/src/modules/catalog/application/search-service.ts';
import {
  searchProducts,
  type SearchProductsQuery,
} from '../../../../apps/api/src/modules/catalog/search.ts';
import { createRootLogger, loadConfig } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createValidatorCompiler,
  type JsonSchema,
} from '../../../../apps/api/src/modules/platform/validation/index.ts';
import { fixture } from '../search/kit.ts';

const root = new URL('../../../../', import.meta.url);
export const headers = {
  'x-app-id': 'synthetic_app',
  'x-platform': 'ios',
  'x-app-version': '1.2.3',
};

export interface Response {
  statusCode: number;
  headers: Record<string, unknown>;
  json<T = unknown>(): T;
}
export interface HttpApp {
  init(): Promise<unknown>;
  close(): Promise<unknown>;
  resolve<T>(provider: abstract new (...args: never[]) => T): Promise<T>;
  inject(request: {
    method: 'GET';
    url: string;
    headers: Record<string, string>;
  }): Promise<Response>;
}

export async function createApp(clock: ReturnType<typeof fixture>['clock']): Promise<HttpApp> {
  const { createHttpApp } = (await import(new URL('apps/api/src/bootstrap.ts', root).href)) as {
    createHttpApp: (
      entry: 'api',
      overrides: {
        config: ReturnType<typeof loadConfig>;
        clock: typeof clock;
        logger: ReturnType<typeof createRootLogger>;
      },
    ) => Promise<HttpApp>;
  };
  return createHttpApp('api', {
    config: loadConfig({ APP_ENV: 'test' }),
    clock,
    logger: createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' }),
  });
}

/** Replace only the use-case port, retaining AppModule, the real controller and route schema.
 * The replacement executes the existing public use case with storage/upstream fakes. It uses
 * Nest's real request-scoped ViewerContext, not a viewer supplied by the HTTP caller.
 */
export async function httpFixture() {
  const f = fixture();
  const viewers: Viewer[] = [];
  const calls: SearchProductsQuery[] = [];
  const original = CatalogModule.forRoot;
  vi.spyOn(CatalogModule, 'forRoot').mockImplementationOnce((configReader) => {
    const module = original(configReader);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []).filter(
          (provider) =>
            provider !== CatalogSearchService &&
            !(typeof provider === 'object' && provider.provide === CatalogSearchService),
        ),
        {
          provide: CatalogSearchService,
          inject: [ViewerContext],
          useFactory: (viewerContext: ViewerContext): CatalogSearchService => ({
            async search(query) {
              calls.push(query);
              const viewer = await viewerContext.current();
              viewers.push(viewer);
              f.setViewer(viewer);
              return searchProducts(query, { ...f.options, viewerContext });
            },
          }),
        },
      ],
    };
  });
  const app = await createApp(f.clock);
  try {
    await app.init();
  } catch (error) {
    await app.close();
    throw error;
  }
  return {
    ...f,
    app,
    viewers,
    calls,
    request(params: Readonly<Record<string, string>> = {}) {
      const query = new URLSearchParams({ platform: 'taobao', q: '合成纸巾', ...params });
      return app.inject({ method: 'GET', url: `/v1/products/search?${query}`, headers });
    },
  };
}

export async function assertContract(response: Response, success: boolean): Promise<void> {
  const requireApi = createRequire(new URL('apps/api/package.json', root));
  const parser = requireApi('@readme/openapi-parser') as {
    dereference(path: string): Promise<{ components: { schemas: Record<string, JsonSchema> } }>;
  };
  const contract = await parser.dereference(fileURLToPath(new URL('contracts/openapi.yaml', root)));
  const schema = contract.components.schemas[success ? 'SearchProductsResponse' : 'ErrorEnvelope'];
  expect(schema).toBeDefined();
  const validate = createValidatorCompiler()({ schema: schema!, httpPart: 'body' });
  expect(validate(response.json()), JSON.stringify(validate.errors)).toBe(true);
}
