// Public surface of the catalog module (规划/02 §4.1); other modules import only from this file.
// Task B1-05c: platform dictionary (BR-PROD-10), product_refs registration and the raw-ID order
// (BR-PROD-05), alias resolution resolveProductKey and isSameProduct (BR-PROD-01, BR-PROD-02),
// the category blocklist filter, and the five ports catalog uses. Rule tests:
// test/spec/catalog/base/**. Task B1-05h: item_ref issue/verify (BR-PROD-11), rule tests
// test/spec/catalog/item-ref/**. Task B1-05f: CardAssembler (priced ProductCard per request,
// BR-PRICE-01/06/07/08/09/11/17/21) and the non-production demo quoter, rule tests
// test/spec/catalog/card/**; no Nest provider until B1-06c wires the link registrar.
// Task B1-05i: createCatalogCardEntry, the single card entry split by D33 price state (retrieval
// skips a price anomaly, an active query fails closed with price_unavailable; PRICE_ANOMALY is
// logged there), rule tests test/spec/catalog/price-state/**. Task B1-05d: searchProducts, the
// single-platform search use case (BR-PROD-07/08/10, BR-PRICE-08/15), rule tests
// test/spec/catalog/search/**; its HTTP route is still planned (ports not assembled yet).
export { createCatalogCardEntry } from './application/card-entry.ts';
export type {
  CatalogCardEntry,
  CatalogCardEntryOptions,
  CatalogCardInput,
  CatalogCardResult,
  CatalogCardScene,
} from './application/card-entry.ts';
export { createCatalog } from './application/catalog.ts';
export { SEARCH_SEEN_LIMIT, SEARCH_SESSION_TTL_SECONDS, searchProducts } from './search.ts';
export type {
  SearchCandidate,
  SearchCursor,
  SearchCursorCodec,
  SearchProductsData,
  SearchProductsOptions,
  SearchProductsQuery,
  SearchSession,
  SearchSessionStore,
  SearchUpstream,
  SearchUpstreamPage,
  SearchUpstreamRequest,
} from './search.ts';
export type { CatalogOptions } from './application/catalog.ts';
export { createCardAssembler, createDemoRebateQuoter } from './application/card-assembler.ts';
export type {
  AssembleCardInput,
  CardAssembler,
  CardAssemblerOptions,
  CardQuoteContext,
  CardRebateQuoter,
  DemoQuoteRule,
  DemoRebateQuoterOptions,
  ProductCard,
} from './application/card-assembler.ts';
export { createItemRefService } from './application/item-ref.ts';
export type {
  ItemRefClaims,
  ItemRefOptions,
  ItemRefRequest,
  ItemRefService,
} from './application/item-ref.ts';
export { CatalogError, RAW_ID_MAX_AGE_MS } from './domain/rules.ts';
export type { CatalogErrorCode } from './domain/rules.ts';
export type {
  Catalog,
  CatalogWarning,
  CategoryCandidate,
  PlatformRecord,
  ProductCapabilities,
  ProductIdentity,
  ProductRef,
  ProductRefSource,
  RawItemRequest,
  RawItemResult,
  ReparseResult,
  RequestRawRef,
} from './domain/types.ts';
export {
  CatalogConfigReader,
  LinkRegistrar,
  RebateQuoter,
  SourceLinkReader,
  ViewerContext,
  createGuestViewerContext,
} from './ports.ts';
export type { RebateQuote, RegisterLinkInput, Viewer } from './ports.ts';
export { CATALOG, CatalogModule } from './catalog.module.ts';
export type { CatalogConfigReaderFactory } from './catalog.module.ts';
