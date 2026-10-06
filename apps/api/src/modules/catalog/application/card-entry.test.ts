import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import type { UnionItem } from '../../union/index.ts';
import type { ProductRef } from '../domain/types.ts';
import type { Viewer } from '../ports.ts';
import { createCatalogCardEntry, type CatalogCardScene } from './card-entry.ts';

const AT = '2026-10-06T10:00:00+08:00';

function item(overrides: Partial<UnionItem> = {}): UnionItem {
  return {
    platform: 'jd',
    item_id: 'unit-item',
    title: 'unit',
    price_fen: 5000n,
    coupon_fen: 0n,
    final_price_fen: 5000n,
    commission_rate_bp: 500n,
    quoted_at: AT,
    ...overrides,
  };
}

const ref: ProductRef = {
  appId: 'app-u',
  platform: 'jd',
  productKey: 'jd:unit',
  rawItemId: 'unit-item',
  rawFetchedAt: AT,
  receivedAt: AT,
  canonicalUrl: null,
  title: 'unit',
  shopId: null,
  shopType: null,
  source: 'search',
};

function setup() {
  const viewer: Viewer = { appId: 'app-u', userId: 'user-u', deviceId: null };
  const current = vi.fn(async () => viewer);
  const register = vi.fn(async () => ({ linkId: 'link-u' }));
  const warn = vi.fn();
  const entry = createCatalogCardEntry({
    clock: new FixedClock(AT),
    viewerContext: { current },
    quoter: {
      quote: async () => ({
        rebateMinFen: 20n,
        rebateMaxFen: 20n,
        estNetPriceFen: 4980n,
        rebateBasis: 'normal',
      }),
    },
    registrar: { register },
    sourceLinks: { entrySource: async () => null },
    itemRefs: { issue: () => 'ref-token' },
    logger: { warn },
  });
  return { entry, current, register, warn };
}

function request(value: UnionItem, scene: CatalogCardScene) {
  return { item: value, ref, entrySource: 'search', stale: false, scene };
}

describe('createCatalogCardEntry', () => {
  it('[AC-B1-05i] BR-PRICE-01: anomaly decided before viewer lookup; log has no viewer or amount', async () => {
    const { entry, current, register, warn } = setup();
    const bad = item({ coupon_fen: 5000n, final_price_fen: 0n });
    await expect(entry.assemble(request(bad, 'retrieval'))).resolves.toEqual({ kind: 'skipped' });
    await expect(entry.assemble(request(bad, 'active_query'))).resolves.toEqual({
      kind: 'price_unavailable',
    });
    expect(current).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    const fields = warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(fields).toEqual({
      code: 'PRICE_ANOMALY',
      scene: 'retrieval',
      platform: 'jd',
      product_key: 'jd:unit',
      price_status: 'invalid_fields',
    });
  });

  it('[AC-B1-05i] BR-PRICE-17: a no-coupon card carries price_basis.general first', async () => {
    const { entry, register, warn } = setup();
    const result = await entry.assemble(request(item(), 'active_query'));
    expect(result).toMatchObject({
      kind: 'card',
      card: { link_id: 'link-u', disclaimer_keys: ['price_basis.general', 'rebate_estimate'] },
    });
    expect(register).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
