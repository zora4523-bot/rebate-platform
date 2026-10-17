import { expect, vi } from 'vitest';
import type {
  ProductCard,
  CatalogCardEntry,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { ToolCallContext } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import type {
  ToolOutcome,
  ToolContext,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import {
  createSearchProductsHandler,
  type AgentSearchCandidate,
  type SearchProductsDeps,
} from '../../../../apps/api/src/modules/agent/tools/search/index.ts';

export const NOW = '2026-10-17T12:00:00+08:00';
export type Platform = AgentSearchCandidate['item']['platform'];

export function context(userId: string | null = 'synthetic-user'): ToolCallContext {
  return {
    appId: 'synthetic-app',
    userId,
    deviceId: 'synthetic-device',
    phoneBound: userId !== null,
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    placeholders: {},
  };
}

export function keywordContext(userId: string | null = 'synthetic-user'): ToolContext {
  const ctx = context(userId);
  return {
    ...ctx,
    subject: {
      ...ctx,
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip',
      traceId: 'synthetic-trace',
    },
  };
}

export function candidate(
  key: string,
  price = 1000,
  platform: Platform = 'taobao',
  quote?: { price_fen: bigint; coupon_fen: bigint },
): AgentSearchCandidate {
  return {
    item: {
      platform,
      item_id: key,
      title: `合成商品 ${key}`,
      price_fen: quote?.price_fen ?? BigInt(price),
      coupon_fen: quote?.coupon_fen ?? 0n,
      final_price_fen: BigInt(price),
      commission_rate_bp: 1000n,
      quoted_at: NOW,
    },
    ref: {
      appId: 'synthetic-app',
      platform,
      productKey: key,
      rawItemId: `synthetic-raw-${key}`,
      rawFetchedAt: NOW,
      receivedAt: NOW,
      canonicalUrl: null,
      title: `合成商品 ${key}`,
      shopId: null,
      shopType: null,
      source: 'search',
    },
    sales: 10,
    categoryId: 'synthetic-allowed-category',
  };
}

/** Literal quote snapshot supplied by the fake card entry, never a sorting/filtering oracle. */
export function card(row: AgentSearchCandidate, patch: Partial<ProductCard> = {}): ProductCard {
  return {
    product_key: row.ref.productKey,
    item_ref: `synthetic-ref-${row.ref.productKey}`,
    platform: row.item.platform,
    shop_type: null,
    title: row.item.title,
    image: 'https://example.invalid/synthetic.png',
    shop_name: '合成店铺',
    price_fen: Number(row.item.price_fen),
    coupon_fen: Number(row.item.coupon_fen),
    final_price_fen: Number(row.item.final_price_fen),
    est_net_price_fen: null,
    rebate_min_fen: 100,
    rebate_max_fen: 100,
    rebate_basis: 'normal',
    benefit_tags: [],
    match_tag: 'matched',
    spec_text: null,
    is_presale: false,
    link_id: `synthetic-link-${row.ref.productKey}`,
    cta: { text_key: 'product.buy' },
    quoted_at: row.item.quoted_at,
    stale: false,
    age_sec: 0,
    source:
      row.item.platform === 'jd'
        ? 'jd_union'
        : row.item.platform === 'pdd'
          ? 'pdd_union'
          : 'taobao_union',
    disclaimer_keys: ['price_basis.general'],
    ad_label: null,
    availability: 'ok',
    ...patch,
  };
}

export function fixture(rows: readonly AgentSearchCandidate[] = []) {
  const settings = new Map<string, boolean | number>([
    ['search.enabled.taobao', true],
    ['search.enabled.jd', true],
    ['search.enabled.pdd', true],
  ]);
  const quotes = new Map<string, ProductCard>();
  const registered: string[] = [];
  const configValue = vi.fn<SearchProductsDeps['config']['configValue']>(async (_app, key) => {
    const value = settings.get(key);
    return value === undefined ? null : { value, version: 1 };
  });
  const searchProducts = vi.fn<SearchProductsDeps['searchProducts']>(async (query) =>
    rows.filter((row) => row.item.platform === query.platform),
  );
  const assemble = vi.fn<CatalogCardEntry['assemble']>(async (input) => {
    const row = rows.find((r) => r.ref.productKey === input.ref.productKey)!;
    const full = quotes.get(input.ref.productKey) ?? card(row);
    const commit = async () => {
      registered.push(input.ref.productKey);
      return full;
    };
    if (input.deferLink !== true) return { kind: 'card', card: await commit() };
    const { link_id, ...unlinked } = full;
    void link_id;
    return { kind: 'prepared', card: unlinked, commit };
  });
  const cardEntry = vi.fn<SearchProductsDeps['cardEntry']>(() => ({ assemble }));
  const prohibited = vi.fn<SearchProductsDeps['prohibited']>(async () => false);
  const categoryAllowed = vi.fn<SearchProductsDeps['categoryAllowed']>(async () => true);
  const cardReference = vi.fn<SearchProductsDeps['cardReference']>(
    (_ctx, index) => `c${index + 12}`,
  );
  const clock = new FixedClock(NOW);
  const deps: SearchProductsDeps = {
    clock,
    config: { configValue },
    platforms: ['taobao', 'jd', 'pdd'],
    searchProducts,
    cardEntry,
    prohibited,
    categoryAllowed,
    newResultSetId: () => 'synthetic-results',
    cardReference,
  };
  return {
    deps,
    settings,
    quotes,
    registered,
    searchProducts,
    assemble,
    cardEntry,
    prohibited,
    categoryAllowed,
    cardReference,
    configValue,
    clock,
    run: (args: Readonly<Record<string, unknown>> = { q: '合成商品' }, ctx = context()) =>
      createSearchProductsHandler(deps).run(args, ctx),
  };
}

export function items(outcome: ToolOutcome): ProductCard[] {
  expect(outcome.kind).toBe('ok');
  if (outcome.kind !== 'ok') return [];
  const lists = outcome.cards.filter((c) => c.type === 'product_list');
  if (lists.length === 0) return [];
  expect(lists).toHaveLength(1);
  return (lists[0]!.data as { items: ProductCard[] }).items;
}

export function keys(outcome: ToolOutcome): string[] {
  return items(outcome).map((c) => c.product_key!);
}
