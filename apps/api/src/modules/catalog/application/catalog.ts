// Catalog use cases: platform dictionary (BR-PROD-10), alias resolution and product identity
// (BR-PROD-01, BR-PROD-02), product_refs registration and the raw-ID order (BR-PROD-05), and the
// category blocklist filter.
import type { DB } from '@couli/db';
import { validateProductKey } from '@couli/domain';
import type { Kysely } from 'kysely';
import type { Clock } from '../../platform/index.ts';
import {
  CatalogError,
  MAX_ALIAS_HOPS,
  effectiveCapabilities,
  filterByRules,
  isFresh,
  isPlatformServed,
  isProductRefSource,
} from '../domain/rules.ts';
import type {
  Catalog,
  CatalogWarning,
  CategoryCandidate,
  PlatformRecord,
  ProductCapabilities,
  ProductIdentity,
  ProductRef,
  RawItemRequest,
  RawItemResult,
} from '../domain/types.ts';
import { createKyselyCatalogStore, type CatalogStore } from '../infra/kysely-catalog-store.ts';

export interface CatalogOptions {
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** Cyclic/overlong alias chains are observable without logging raw upstream IDs. */
  readonly warn: (event: CatalogWarning) => void;
}

export function createCatalog(options: CatalogOptions): Catalog {
  return new CatalogService(createKyselyCatalogStore(options.db), options.clock, options.warn);
}

class CatalogService implements Catalog {
  private readonly store: CatalogStore;
  private readonly clock: Clock;
  private readonly warn: (event: CatalogWarning) => void;

  constructor(store: CatalogStore, clock: Clock, warn: (event: CatalogWarning) => void) {
    this.store = store;
    this.clock = clock;
    this.warn = warn;
  }

  /** Read from the table on every call: capability changes are seen by the next reader. */
  async listPlatforms(): Promise<readonly PlatformRecord[]> {
    return await this.store.listPlatforms();
  }

  /**
   * BR-PROD-10: the code must be a row of platforms, matched exactly (no numeric codes, no
   * `tmall`, no case folding), and parsing or search must be available; otherwise 30131.
   */
  async requirePlatform(code: string, capabilities: ProductCapabilities): Promise<PlatformRecord> {
    const record = typeof code === 'string' ? await this.store.findPlatform(code) : null;
    if (record === null || !isPlatformServed(record, capabilities)) {
      throw new CatalogError(30131, 'catalog: platform not supported');
    }
    return record;
  }

  /**
   * BR-PROD-02: follows product_key_aliases to the end of the chain. More than MAX_ALIAS_HOPS
   * hops, or a cycle, returns the key unchanged and reports a warning.
   */
  async resolveProductKey(key: string): Promise<string> {
    const seen = new Set<string>([key]);
    let current = key;
    for (let hops = 0; ; hops += 1) {
      const next = await this.store.nextAlias(current);
      if (next === null) return current;
      if (seen.has(next)) {
        this.warn({ kind: 'alias_cycle', key });
        return key;
      }
      if (hops + 1 > MAX_ALIAS_HOPS) {
        this.warn({ kind: 'alias_limit', key });
        return key;
      }
      seen.add(next);
      current = next;
    }
  }

  /**
   * BR-PROD-01: same app_id, same platform, both keys non-null and byte-equal after resolving
   * both sides. App and platform are compared before any alias lookup.
   */
  async isSameProduct(left: ProductIdentity, right: ProductIdentity): Promise<boolean> {
    if (left.appId !== right.appId || left.platform !== right.platform) return false;
    if (left.productKey === null || right.productKey === null) return false;
    const [a, b] = await Promise.all([
      this.resolveProductKey(left.productKey),
      this.resolveProductKey(right.productKey),
    ]);
    return a === b;
  }

  /**
   * BR-PROD-05 / BR-PROD-10: only search / detail / parse / pool may write; the platform must be
   * served (30131) and the key must carry that platform's prefix. refreshed_at is the response's
   * receipt instant; an older or equal response never overwrites a newer row.
   */
  async registerProductRef(ref: ProductRef, capabilities: ProductCapabilities): Promise<void> {
    if (!isProductRefSource(ref.source)) {
      throw new Error('catalog: product_refs accepts only search, detail, parse and pool');
    }
    const record = await this.requirePlatform(ref.platform, capabilities);
    validateProductKey(
      ref.productKey,
      [
        {
          platform: record.code,
          keyPrefix: record.key_prefix,
          ...effectiveCapabilities(record, capabilities),
        },
      ],
      ref.platform,
    );
    if (typeof ref.rawItemId !== 'string' || ref.rawItemId === '') {
      throw new Error('catalog: raw_item_id must be a non-empty string');
    }
    if (!Number.isFinite(Date.parse(ref.receivedAt))) {
      throw new Error('catalog: receivedAt must be an instant');
    }
    if (!Number.isFinite(Date.parse(ref.rawFetchedAt))) {
      throw new Error('catalog: rawFetchedAt must be an instant');
    }
    await this.store.upsertProductRef(ref, this.clock.now());
  }

  async readProductRef(identity: ProductIdentity): Promise<ProductRef | null> {
    if (identity.productKey === null) return null;
    return await this.store.readProductRef(identity.appId, identity.platform, identity.productKey);
  }

  /**
   * BR-PROD-05 order: ① the request's item_ref / link raw ID of this very product, obtained
   * ≤ 1800 s ago; ② product_refs of (app_id, product_key) refreshed ≤ 1800 s ago, skipped when the
   * fallback key is enabled; ③ re-parse. A stale raw ID is never returned on any path.
   */
  async takeRawItemId(request: RawItemRequest): Promise<RawItemResult> {
    const nowMs = this.clock.now().getTime();
    const key = await this.resolveProductKey(request.productKey);

    const requestRef = request.requestRef;
    if (
      requestRef !== null &&
      requestRef.appId === request.appId &&
      requestRef.platform === request.platform &&
      isFresh(requestRef.fetchedAt, nowMs) &&
      (await this.resolveProductKey(requestRef.productKey)) === key
    ) {
      return { rawItemId: requestRef.rawItemId, source: requestRef.source };
    }

    if (!request.fallbackEnabled) {
      const stored = await this.store.readProductRef(request.appId, request.platform, key);
      if (stored !== null && isFresh(stored.receivedAt, nowMs)) {
        return { rawItemId: stored.rawItemId, source: 'product_refs' };
      }
    }

    const identity: ProductIdentity = {
      appId: request.appId,
      platform: request.platform,
      productKey: key,
    };
    // A rejection of reparse propagates as it is: nothing older is used in its place.
    const result = await request.reparse(identity);
    switch (result.kind) {
      case 'off_shelf':
        throw new CatalogError(30141, 'catalog: item is off the shelf');
      case 'ref_expired':
        throw new CatalogError(30143, 'catalog: product reference expired');
      case 'temporary_failure':
        throw new CatalogError(50401, 'catalog: re-parse failed temporarily');
      case 'found':
        break;
    }
    const found = result.ref;
    if (
      found.appId !== request.appId ||
      found.platform !== request.platform ||
      (await this.resolveProductKey(found.productKey)) !== key
    ) {
      // A different product, app or platform: the reference no longer leads to this product.
      throw new CatalogError(30143, 'catalog: re-parse returned another product');
    }
    if (!isFresh(found.rawFetchedAt, nowMs)) {
      throw new CatalogError(50401, 'catalog: re-parse returned a stale raw id');
    }
    // Stored under the resolved key, so that step ② of the next request finds it.
    await this.registerProductRef({ ...found, productKey: key }, request.capabilities);
    return { rawItemId: found.rawItemId, source: 'reparse' };
  }

  async filterCategories<T extends CategoryCandidate>(
    appId: string,
    items: readonly T[],
  ): Promise<T[]> {
    if (items.length === 0) return [];
    return filterByRules(items, await this.store.activeCategoryRules(appId));
  }
}
