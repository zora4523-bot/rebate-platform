// Public surface of the catalog module (规划/02 §4.1); other modules import only from this file.
// Task B1-05c: platform dictionary (BR-PROD-10), product_refs registration and the raw-ID order
// (BR-PROD-05), alias resolution resolveProductKey and isSameProduct (BR-PROD-01, BR-PROD-02),
// the category blocklist filter, and the five ports catalog uses. Rule tests:
// test/spec/catalog/base/**.
export { createCatalog } from './application/catalog.ts';
export type { CatalogOptions } from './application/catalog.ts';
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
