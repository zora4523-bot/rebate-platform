import {
  getProduct,
  type ProductDetailData,
  type ProductDetailOptions,
  type ProductDetailQuery,
} from '../detail.ts';

/**
 * Request-scoped HTTP use-case port of GET /v1/products/{product_key}: the contract-validated
 * path and query plus the server-owned ports CatalogModule assembles (viewer, configuration,
 * union upstream, card entry). Plain class, no decorators: rule tests import this file.
 */
export class CatalogDetailService {
  // The options stay in a closure: the instance type is exactly { get }.
  readonly get: (query: ProductDetailQuery) => Promise<ProductDetailData>;

  constructor(options: ProductDetailOptions) {
    this.get = (query) => getProduct(query, options);
  }
}
