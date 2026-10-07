// Pure catalog rules: platform support (BR-PROD-10), raw-ID freshness (BR-PROD-05), product_refs
// sources (BR-PROD-05), alias chain limit (BR-PROD-02) and category filtering. No I/O, no clock.
import type {
  CategoryCandidate,
  CategoryRule,
  PlatformRecord,
  ProductCapabilities,
  ProductRefSource,
} from './types.ts';

/** Contract error codes this module raises (contracts/error-codes.yaml). */
export type CatalogErrorCode = 20001 | 30131 | 30141 | 30143 | 50304 | 50401;

/** A business error carrying its contract code; HTTP mapping belongs to the controllers. */
export class CatalogError extends Error {
  readonly code: CatalogErrorCode;
  /** Envelope `data` for codes that carry it (50304: platform, optional reason). */
  readonly data?: Readonly<Record<string, string>>;

  constructor(
    code: CatalogErrorCode,
    message: string,
    data?: Readonly<Record<string, string>>,
    /** The underlying failure (e.g. a swallowed union error behind 50304); never sent to clients. */
    options?: { readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CatalogError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** BR-PROD-05: a raw ID is usable while (now − obtained) ≤ 1800 s, boundary included. */
export const RAW_ID_MAX_AGE_MS = 1_800_000;

/** BR-PROD-02 细则: at most five alias hops; longer chains and cycles keep the original key. */
export const MAX_ALIAS_HOPS = 5;

/** BR-PROD-05: the only sources allowed to write product_refs (order sync never does). */
export const PRODUCT_REF_SOURCES: ReadonlySet<string> = new Set<ProductRefSource>([
  'search',
  'detail',
  'parse',
  'pool',
]);

export function isProductRefSource(value: unknown): value is ProductRefSource {
  return typeof value === 'string' && PRODUCT_REF_SOURCES.has(value);
}

/**
 * Freshness of an instant (ISO string) against now (epoch ms). An unparsable instant is stale,
 * so it can never be used.
 */
export function isFresh(obtainedAt: string, nowMs: number): boolean {
  const at = Date.parse(obtainedAt);
  return Number.isFinite(at) && nowMs - at <= RAW_ID_MAX_AGE_MS;
}

/**
 * BR-PROD-10: a platform is served when parsing is enabled, or when keyword search is enabled
 * and the dictionary does not mark search as unavailable ('none'). Convert support plays no part.
 */
export function isPlatformServed(
  record: PlatformRecord,
  capabilities: ProductCapabilities,
): boolean {
  const effective = effectiveCapabilities(record, capabilities);
  return effective.parseEnabled || effective.searchEnabled;
}

/** Runtime switches narrowed by the dictionary: a switch cannot create a missing capability. */
export function effectiveCapabilities(
  record: PlatformRecord,
  capabilities: ProductCapabilities,
): ProductCapabilities {
  return {
    parseEnabled: capabilities.parseEnabled === true,
    searchEnabled: capabilities.searchEnabled === true && record.search_support !== 'none',
  };
}

/**
 * Category filter: an item is dropped when an active rule of its platform and category has no
 * keyword, or has a keyword that occurs in the title as a literal substring (no regex, no case
 * folding). Order and the item objects are preserved; the input is not modified.
 */
export function filterByRules<T extends CategoryCandidate>(
  items: readonly T[],
  rules: readonly CategoryRule[],
): T[] {
  if (rules.length === 0) return [...items];
  return items.filter(
    (item) =>
      !rules.some(
        (rule) =>
          rule.platform === item.platform &&
          rule.categoryId === item.categoryId &&
          (rule.keyword === null || item.title.includes(rule.keyword)),
      ),
  );
}
