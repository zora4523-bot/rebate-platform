// Public surface of the catalog module (规划/02 §4.1); other modules import only from this file.
// Task B1-05c: platform dictionary (BR-PROD-10), product_refs registration and the raw-ID order
// (BR-PROD-05), alias resolution resolveProductKey and isSameProduct (BR-PROD-01, BR-PROD-02),
// the category blocklist filter, and the five ports catalog uses. Rule tests:
// test/spec/catalog/base/**. Task B1-05h: item_ref issue/verify (BR-PROD-11), rule tests
// test/spec/catalog/item-ref/**. Task B1-05f: CardAssembler (priced ProductCard per request,
// BR-PRICE-01/06/07/08/09/11/17/21) and the non-production demo quoter, rule tests
// test/spec/catalog/card/**; no Nest provider until B1-06c wires the link registrar.
import type { Logger } from 'pino';
import type {
  AssembleCardInput,
  CardAssemblerOptions,
  ProductCard,
} from './application/card-assembler.ts';

/** The request's purpose is independent of its inherited link entry_source. */
export type CatalogCardScene = 'retrieval' | 'active_query';

export interface CatalogCardInput extends AssembleCardInput {
  readonly scene: CatalogCardScene;
}

/** Internal result, not a replacement for the wire ProductCard contract. */
export type CatalogCardResult =
  | { readonly kind: 'card'; readonly card: ProductCard }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'price_unavailable' };

export interface CatalogCardEntryOptions extends CardAssemblerOptions {
  /** Emit a flat warning with code PRICE_ANOMALY at the anomaly decision. */
  readonly logger: Pick<Logger, 'warn'>;
}

export interface CatalogCardEntry {
  assemble(input: CatalogCardInput): Promise<CatalogCardResult>;
}

// TODO(规划/11 §9.2): price_unavailable 卡不带金额与 link_id — blocked on F-37 契约同步。
/** B1-05i: the common card entry for retrieval and active price queries. */
export function createCatalogCardEntry(options: CatalogCardEntryOptions): CatalogCardEntry {
  void options;
  throw new Error('NotImplemented: createCatalogCardEntry');
}

export { createCatalog } from './application/catalog.ts';
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
