// B1-06w: the open's price port — the re-check item of the opened link through the governed union
// adapter (purpose online; governance adds signal, base URL and headers), normalized into
// catalog's card input. It reads no database: it runs inside the open's transaction (B1-06m).
// An unavailable item (union item_unavailable, the demo delisted scenario) is off-shelf; any other
// failure rejects and the open takes its requote-failed branch (BR-PRICE-13).
import type { ProductRef } from '../../catalog/index.ts';
import { newUuidV7, type Clock } from '../../platform/index.ts';
import {
  DemoUnionError,
  UnionError,
  type ItemRef,
  type RegisteredPlatform,
  type UnionAdapter,
} from '../../union/index.ts';
import type { LinkOpenOwnerResult } from './link-open-owner.ts';
import { itemRefOf } from './link-open-conversion.ts';
import type { LinkOpenPrice } from './link-open-requote.ts';

export interface LinkOpenPricesOptions {
  readonly clock: Clock;
  /** The process's governed adapters (app.module's GovernedUnion). */
  readonly union: { adapter(platform: RegisteredPlatform): Pick<UnionAdapter, 'getItem'> };
}

export interface LinkOpenPrices {
  fetch(owner: LinkOpenOwnerResult): Promise<LinkOpenPrice>;
}

function unavailable(error: unknown): boolean {
  if (error instanceof UnionError) return error.code === 'item_unavailable';
  return error instanceof DemoUnionError && error.code === 'demo_delisted';
}

export function createLinkOpenPrices(options: LinkOpenPricesOptions): LinkOpenPrices {
  const { clock, union } = options;

  async function fetch(owner: LinkOpenOwnerResult): Promise<LinkOpenPrice> {
    const { link } = owner;
    const platform = link.platform;
    if (platform !== 'jd' && platform !== 'pdd' && platform !== 'taobao') {
      throw new Error('linking: no re-check price source for this platform');
    }
    if (link.raw_item_id === null || link.raw_item_id === '' || link.product_key === null) {
      throw new Error('linking: link has no raw item id or product key to re-check');
    }
    // B1-06f: Taobao re-checks through the item detail only (no union link API is called).
    const ref: ItemRef =
      platform === 'taobao'
        ? { platform: 'taobao', item_id: link.raw_item_id }
        : itemRefOf(platform, link.raw_item_id);
    let item;
    try {
      item = await union.adapter(platform).getItem(ref, {
        appId: link.app_id,
        requestId: newUuidV7(clock.now()),
        purpose: 'online',
      });
    } catch (error) {
      if (unavailable(error)) return { kind: 'off_shelf' };
      throw error;
    }
    const product: ProductRef = {
      appId: link.app_id,
      platform,
      productKey: link.product_key,
      rawItemId: link.raw_item_id,
      rawFetchedAt: item.quoted_at,
      receivedAt: clock.now().toISOString(),
      // Never a pasted or converted URL (BR-PRICE-08).
      canonicalUrl: null,
      title: item.title,
      shopId: null,
      shopType: null,
      source: 'detail',
    };
    return {
      kind: 'available',
      input: { item, ref: product, entrySource: link.entry_source, stale: false },
    };
  }

  return { fetch };
}
