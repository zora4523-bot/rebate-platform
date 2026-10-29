import type { HotRankData, HotRankOptions, HotRankQuery } from '../hot-rank.ts';

/**
 * Request-scoped HTTP use-case port of GET /v1/rank/hot: the contract-validated query plus the
 * server-owned ports CatalogModule assembles. Plain class, no decorators: rule tests import this
 * file.
 */
export class CatalogHotRankService {
  constructor(options: HotRankOptions) {
    void options;
    throw new Error('NotImplemented: CatalogHotRankService');
  }

  hot(query: HotRankQuery): Promise<HotRankData> {
    void query;
    throw new Error('NotImplemented: CatalogHotRankService.hot');
  }
}
