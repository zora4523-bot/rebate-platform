// B1-05m: GET /v1/search/hot-words (contract getSearchHotWords, CT-22c). Rule tests:
// test/spec/catalog/hot-words/**.
import { Controller, Get, Inject, Req } from '@nestjs/common';
import { RouteSchema } from '@nestjs/platform-fastify';
import type { Schema } from '@couli/contracts-ts';
import { ROOT_LOGGER, contractRouteSchema, type RootLogger } from '../../../platform/index.ts';
import { readSearchHotWords } from '../../hot-words/read.ts';
import { CatalogConfigReader } from '../../ports.ts';

type SearchHotWordsResponse = Schema<'SearchHotWordsResponse'>;

interface HotWordsRequest {
  /** Trace id set by `genReqId`. */
  readonly id: string;
  /** X-App-Id, required and validated by the route schema. */
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * Contract operation `getSearchHotWords` (x-auth none, no device id; readable in basic mode): the
 * request app's search.hot_words and search.keyword_routes as configured. No statistics are
 * kept (F-PROD-10 is P1) and keywords are matched by the client, not here.
 * Nest metadata is applied below without decorator syntax (same as SearchController).
 */
export class HotWordsController {
  readonly #config: CatalogConfigReader;
  readonly #logger: RootLogger;

  constructor(config: CatalogConfigReader, logger: RootLogger) {
    this.#config = config;
    this.#logger = logger;
  }

  async get(request: HotWordsRequest): Promise<SearchHotWordsResponse> {
    const appId = request.headers['x-app-id'];
    if (typeof appId !== 'string' || appId === '') {
      throw new Error('catalog: hot words request carries no app scope');
    }
    const data = await readSearchHotWords({ config: this.#config, logger: this.#logger }, appId);
    return { code: 0, msg: '', data, trace_id: request.id };
  }
}

Controller('v1')(HotWordsController);
Inject(CatalogConfigReader)(HotWordsController, undefined, 0);
Inject(ROOT_LOGGER)(HotWordsController, undefined, 1);
const getMethod = Object.getOwnPropertyDescriptor(HotWordsController.prototype, 'get')!;
Get('search/hot-words')(HotWordsController.prototype, 'get', getMethod);
RouteSchema(contractRouteSchema('getSearchHotWords'))(
  HotWordsController.prototype,
  'get',
  getMethod,
);
Req()(HotWordsController.prototype, 'get', 0);
