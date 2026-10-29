// B1-28h HTTP kit: the real app, route schema and controller of GET /v1/rank/hot. httpFixture
// replaces only the use-case port CatalogHotRankService with getHotRank over the kit's fakes.
import { vi } from 'vitest';
import { CatalogModule } from '../../../../apps/api/src/modules/catalog/index.ts';
import { CatalogHotRankService } from '../../../../apps/api/src/modules/catalog/application/hot-rank-service.ts';
import {
  getHotRank,
  type HotRankQuery,
} from '../../../../apps/api/src/modules/catalog/hot-rank.ts';
import { createApp, type HttpApp } from '../search-route/http-kit.ts';
import { APP, fixture } from './kit.ts';

/** Contract headers of getHotRank; never an Authorization header (x-auth none). */
export const headers = {
  'x-app-id': APP,
  'x-platform': 'ios',
  'x-app-version': '1.2.3',
  'x-device-id': '01920000-0000-7000-8000-00000000d001',
};

export function hotRankRequest(app: HttpApp, params: Readonly<Record<string, string>>) {
  const query = new URLSearchParams({ ...params });
  return app.inject({ method: 'GET', url: `/v1/rank/hot?${query}`, headers });
}

export async function startApp(clock: ReturnType<typeof fixture>['clock']): Promise<HttpApp> {
  const app = await createApp(clock);
  try {
    await app.init();
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}

export async function httpFixture() {
  const f = fixture();
  const calls: HotRankQuery[] = [];
  const original = CatalogModule.forRoot;
  vi.spyOn(CatalogModule, 'forRoot').mockImplementationOnce((...args) => {
    const module = original(...args);
    return {
      ...module,
      providers: [
        ...(module.providers ?? []).filter(
          (provider) =>
            provider !== CatalogHotRankService &&
            !(typeof provider === 'object' && provider.provide === CatalogHotRankService),
        ),
        {
          provide: CatalogHotRankService,
          useValue: {
            hot(query: HotRankQuery) {
              calls.push(query);
              return getHotRank(query, f.options);
            },
          },
        },
      ],
    };
  });
  const app = await startApp(f.clock);
  return {
    ...f,
    app,
    calls,
    request(params: Readonly<Record<string, string>> = {}) {
      return hotRankRequest(app, { platform: 'taobao', ...params });
    },
  };
}
