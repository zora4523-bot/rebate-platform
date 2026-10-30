import {
  getSectionItems,
  type PageSectionItemsData,
  type SectionItemsOptions,
  type SectionItemsQuery,
} from '../section-items.ts';

/**
 * Request-scoped HTTP use-case port of GET /v1/pages/{page_key}/sections/{section_id}/items: the
 * contract-validated parameters plus the server-owned ports CatalogModule assembles. Plain class,
 * no decorators: rule tests import this file.
 */
export class CatalogSectionItemsService {
  // The options stay in a closure: the instance type is exactly { items }.
  readonly items: (query: SectionItemsQuery) => Promise<PageSectionItemsData>;

  constructor(options: SectionItemsOptions) {
    this.items = (query) => getSectionItems(query, options);
  }
}
