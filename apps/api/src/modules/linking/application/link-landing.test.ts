import { describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../platform/index.ts';
import { createLinkLanding, createSnapshotCardReader, type LandingLink } from './link-landing.ts';

const APP = 'synthetic_landing_unit';
const LINK = '0199a3b4-5c6d-7000-8000-0000000000a1';
const QUOTED = '2026-10-07T03:02:01.000Z';

function link(overrides: Partial<LandingLink> = {}): LandingLink {
  return {
    link_id: LINK,
    app_id: APP,
    user_id: null,
    device_id: null,
    platform: 'jd',
    product_key: 'jd:i_syn01',
    raw_item_id: 'syn-item-01',
    raw_fetched_at: new Date(QUOTED),
    scene: 'search',
    sub_scene: null,
    pid_scene: 'self_buy',
    pid: 'synthetic-pid',
    entry_source: 'search',
    identity_snapshot: { user_id: null, platform: 'jd', pid_scene: 'self_buy' },
    convert_result: null,
    cache_hit: false,
    quoted_final_price_fen: 10000n,
    quoted_coupon_fen: 2000n,
    quoted_coupon_id: null,
    quoted_at: new Date(QUOTED),
    expire_at: new Date(QUOTED),
    agent_session_id: null,
    agent_card_id: null,
    row_version: 0,
    created_at: new Date(QUOTED),
    updated_at: new Date(QUOTED),
    promo_url: null,
    promo_url_fetched_at: null,
    ...overrides,
  } as LandingLink;
}

describe('link landing: malformed link_id (B1-06j)', () => {
  it.each(['not-a-uuid', '', `${LINK}x`, "0199a3b4-5c6d-7000-8000-00000000'1"])(
    '[AC-B1-06j] %j answers 30144 like an unknown link, without reading links',
    async (linkId) => {
      const current = vi.fn(async () => ({ appId: APP, userId: null, deviceId: null }));
      const find = vi.fn(async () => null);
      const read = vi.fn();
      const service = createLinkLanding({
        callerContext: { current },
        links: { find },
        cards: { read },
      });
      const result = await service.get({ linkId, traceId: 'synthetic-trace' });
      expect(result).toEqual({
        status: 404,
        envelope: { code: 30144, msg: '链接不存在', trace_id: 'synthetic-trace' },
      });
      expect(find).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    },
  );
});

describe('link landing: snapshot card with catalog product fields (B1-06j)', () => {
  const clock = new FixedClock('2026-10-07T03:03:01.000Z');
  const itemRefs = { issue: vi.fn(() => 'synthetic-ref') };

  it('[AC-B1-06j] title and shop type come from the product port; prices from the snapshot', async () => {
    const products = {
      read: vi.fn(async () => ({
        title: '合成商品',
        image: null,
        shopName: null,
        shopType: 'tmall',
      })),
    };
    const reader = createSnapshotCardReader({ clock, itemRefs, products });
    const card = await reader.read(link());
    expect(products.read).toHaveBeenCalledWith({
      appId: APP,
      platform: 'jd',
      productKey: 'jd:i_syn01',
      rawItemId: 'syn-item-01',
    });
    expect(card).toMatchObject({
      title: '合成商品',
      shop_type: 'tmall',
      image: null,
      shop_name: null,
      price_fen: 12000,
      coupon_fen: 2000,
      final_price_fen: 10000,
      age_sec: 60,
      availability: 'ok',
    });
  });

  it('[AC-B1-06j] a negative snapshot price is refused, never serialized', async () => {
    const products = {
      read: async () => ({ title: null, image: null, shopName: null, shopType: null }),
    };
    const reader = createSnapshotCardReader({ clock, itemRefs, products });
    await expect(reader.read(link({ quoted_coupon_fen: -1n }))).rejects.toThrow(RangeError);
  });
});
