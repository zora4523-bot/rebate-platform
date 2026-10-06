import type { components } from '@couli/contracts-ts';
import type {
  Catalog,
  CatalogCardEntry,
  CatalogConfigReader,
  ProductCard,
  ProductRef,
} from '../catalog/index.ts';
import type { Clock, LinkPatternsSpec } from '../platform/index.ts';
import type { CallCtx, RegisteredPlatform, UnionAdapter, UnionItemDetail } from '../union/index.ts';

/** ContentReader implements this port; production wiring belongs to the implementation phase. */
export type ParsingConfigReader = Pick<CatalogConfigReader, 'configValue'>;

export interface ParsingOptions {
  readonly config: ParsingConfigReader;
  readonly catalog: Pick<Catalog, 'listPlatforms' | 'resolveProductKey'>;
  readonly cards: CatalogCardEntry;
  readonly clock: Clock;
  /** Supplied adapters must already pass through union governance. */
  readonly getGovernedAdapter: (
    platform: RegisteredPlatform,
  ) => Pick<UnionAdapter, 'resolveLink' | 'getItem'>;
  /** Omission uses platform.getLinkPatterns(); overrides are synthetic test fixtures. */
  readonly linkPatterns?: LinkPatternsSpec;
}

export interface ParsingUrlMatch {
  readonly platform: string;
  readonly category: 'product' | 'promo' | 'union_host';
}

export type ParsingHit = components['schemas']['InputHit'];

/** Internal D33 result; price_unavailable is deliberately not a fabricated wire card. */
export type ParsingResult =
  | { readonly kind: 'card'; readonly hit: ParsingHit; readonly card: ProductCard }
  | { readonly kind: 'error'; readonly hit: ParsingHit | null; readonly error_code: number }
  | {
      readonly kind: 'price_unavailable';
      readonly hit: ParsingHit;
      readonly productKey: string;
    };

export interface ParsingService {
  parseInput(text: string, context: CallCtx): Promise<readonly ParsingResult[]>;
}

export interface ParsedUrlProduct {
  readonly item: UnionItemDetail;
  readonly ref: ProductRef;
}

/** Host/path classification only; specific product/promo rules take precedence over union_host. */
export function classifyParsingUrl(
  url: string,
  patterns: LinkPatternsSpec,
): ParsingUrlMatch | null {
  void url;
  void patterns;
  throw new Error('NotImplemented: classifyParsingUrl');
}

/** B1-06i port: resolves and derives a product without registering a card or converting a link. */
export function parseUrl(
  options: ParsingOptions,
  url: string,
  context: CallCtx,
): Promise<ParsedUrlProduct> {
  void options;
  void url;
  void context;
  throw new Error('NotImplemented: parseUrl');
}

/** Shared pure-code use case for the later HTTP and Agent entry points. */
export function createParsing(options: ParsingOptions): ParsingService {
  void options;
  throw new Error('NotImplemented: createParsing');
}
