import {
  searchProducts,
  type SearchProductsData,
  type SearchProductsOptions,
  type SearchProductsQuery,
} from '../search.ts';

/**
 * Request-scoped HTTP use-case port of GET /v1/products/search: the contract-validated query
 * plus the server-owned ports CatalogModule assembles (viewer, configuration, union upstream,
 * sessions, card entry). Plain class, no decorators: rule tests import this file.
 */
export class CatalogSearchService {
  // The options stay in a closure: the instance type is exactly { search }.
  readonly search: (query: SearchProductsQuery) => Promise<SearchProductsData>;

  constructor(options: SearchProductsOptions) {
    this.search = (query) => searchProducts(query, options);
  }
}
