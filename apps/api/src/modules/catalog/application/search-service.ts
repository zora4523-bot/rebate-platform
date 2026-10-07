import type { SearchProductsData, SearchProductsQuery } from '../search.ts';

/** Request-scoped HTTP use-case port; assembled with server-owned dependencies by the app. */
export class CatalogSearchService {
  search(query: SearchProductsQuery): Promise<SearchProductsData> {
    void query;
    throw new Error('NotImplemented: CatalogSearchService.search');
  }
}
