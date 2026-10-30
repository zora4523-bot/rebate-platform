import { expect, it, vi } from 'vitest';
import type { UnionItem } from '../union/index.ts';
import type { ProductCard } from './application/card-assembler.ts';
import type { CatalogCardEntry, CatalogCardInput } from './application/card-entry.ts';
import type { ProductRef } from './domain/types.ts';
import type { HotRankUpstream, HotRankUpstreamPage } from './hot-rank.ts';
import { createGuestViewerContext } from './ports.ts';
import { getSectionItems, type SectionItemsOptions } from './section-items.ts';

const channel = { platform: 'taobao', channel_id: 'synthetic_ch' } as const;

/** The card entry's real output leaves ad_label out, as this fake does. */
function cards(): CatalogCardEntry & { assemble: ReturnType<typeof vi.fn> } {
  return {
    assemble: vi.fn(async (input: CatalogCardInput) => {
      const card = { rebate_basis: 'estimated', product_key: input.ref.productKey };
      const commit = async () => ({ ...card, link_id: `link-${input.ref.productKey}` });
      return { kind: 'prepared', card, commit };
    }),
  } as unknown as CatalogCardEntry & { assemble: ReturnType<typeof vi.fn> };
}

function pageOf(names: readonly string[], extra: Partial<HotRankUpstreamPage> = {}) {
  return {
    items: names.map((name) => ({
      item: { title: name } as unknown as UnionItem,
      ref: { productKey: `tb:${name}` } as unknown as ProductRef,
      salesText: null,
    })),
    hasMore: false,
    ...extra,
  };
}

function optionsOf(entry: CatalogCardEntry, page: HotRankUpstreamPage): SectionItemsOptions {
  const upstream: HotRankUpstream = {
    categories: async () => [],
    page: async () => page,
  };
  return {
    viewerContext: createGuestViewerContext({ appId: 'synthetic', deviceId: null }),
    cards: entry,
    channels: () => ({
      version: 'synthetic',
      channels: [
        { ...channel, name: '合成', sort_basis: 'sales', selectable: true, source: 'synthetic' },
      ],
    }),
    upstream,
    pages: {
      section: async () => ({ dataSource: { kind: 'union_material', channels: [channel] } }),
    },
    logger: { warn: vi.fn() },
  };
}

const query = { pageKey: 'home', sectionId: 'synthetic_feed' };

it('[AC-B1-05o] 每张卡都显式下发 ad_label: null，键存在', async () => {
  const data = await getSectionItems(query, optionsOf(cards(), pageOf(['a', 'b'])));

  expect(data.items).toHaveLength(2);
  for (const card of data.items as readonly Partial<ProductCard>[]) {
    expect(Object.keys(card)).toContain('ad_label');
    expect(card.ad_label).toBeNull();
  }
});

it('[AC-B1-05o] 旧副本页的卡标 stale，正常页不标', async () => {
  const oldCopy = cards();
  await getSectionItems(query, optionsOf(oldCopy, pageOf(['a'], { stale: true })));
  const fresh = cards();
  await getSectionItems(query, optionsOf(fresh, pageOf(['a'])));

  expect(oldCopy.assemble.mock.calls[0]![0]).toMatchObject({ stale: true });
  expect(fresh.assemble.mock.calls[0]![0]).toMatchObject({ stale: false });
});
