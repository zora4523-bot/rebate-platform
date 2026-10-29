import {
  getHotRank,
  type HotRankData,
  type HotRankOptions,
  type HotRankQuery,
} from '../hot-rank.ts';

/**
 * Request-scoped HTTP use-case port of GET /v1/rank/hot: the contract-validated query plus the
 * server-owned ports CatalogModule assembles. Plain class, no decorators: rule tests import this
 * file.
 */
export class CatalogHotRankService {
  // The options stay in a closure: the instance type is exactly { hot }.
  readonly hot: (query: HotRankQuery) => Promise<HotRankData>;

  constructor(options: HotRankOptions) {
    this.hot = (query) => getHotRank(query, options);
  }
}
