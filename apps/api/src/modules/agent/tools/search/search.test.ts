// Implementer unit tests for B3-04b (rule tests live in test/spec/agent/tools-search).
import { describe, expect, it, vi } from 'vitest';
import type { CatalogCardEntry, ProductCard } from '../../../catalog/index.ts';
import { FixedClock } from '../../../platform/index.ts';
import type { ToolContext } from '../../orchestrator/index.ts';
import type { ToolCallContext } from '../registry/index.ts';
import {
  createKeywordSearch,
  createSearchProductsHandler,
  type AgentSearchCandidate,
  type SearchProductsDeps,
} from './index.ts';

const NOW = '2026-10-17T12:00:00+08:00';
type Platform = AgentSearchCandidate['item']['platform'];

function ctx(): ToolCallContext {
  return {
    appId: 'synthetic-app',
    userId: 'synthetic-user',
    deviceId: 'synthetic-device',
    phoneBound: true,
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    placeholders: {},
  };
}

function keywordCtx(): ToolContext {
  const c = ctx();
  return {
    subject: { ...c, deviceHash: 'synthetic-hash', ipKey: 'synthetic-ip', traceId: 'synthetic' },
    runId: c.runId,
    sessionId: c.sessionId,
    signal: c.signal,
    placeholders: {},
  };
}

function candidate(key: string, platform: Platform): AgentSearchCandidate {
  return {
    item: {
      platform,
      item_id: key,
      title: `合成商品 ${key}`,
      price_fen: 1000n,
      coupon_fen: 0n,
      final_price_fen: 1000n,
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
    sales: 1,
    categoryId: 'synthetic-category',
  };
}

function card(row: AgentSearchCandidate): ProductCard {
  return {
    product_key: row.ref.productKey,
    item_ref: 'synthetic-ref',
    platform: row.item.platform,
    title: row.item.title,
    image: 'https://example.invalid/synthetic.png',
    price_fen: 1000,
    coupon_fen: 0,
    final_price_fen: 1000,
    est_net_price_fen: null,
    rebate_min_fen: 100,
    rebate_max_fen: 100,
    rebate_basis: 'normal',
    benefit_tags: [],
    is_presale: false,
    link_id: `synthetic-link-${row.ref.productKey}`,
    cta: { text_key: 'product.buy' },
    quoted_at: NOW,
    stale: false,
    age_sec: 0,
    source: row.item.platform === 'jd' ? 'jd_union' : 'taobao_union',
    disclaimer_keys: ['price_basis.general'],
    availability: 'ok',
  };
}

function setup(rows: readonly AgentSearchCandidate[], failing: ReadonlySet<string>) {
  const registered: string[] = [];
  const searchProducts = vi.fn<SearchProductsDeps['searchProducts']>(async (query) =>
    rows.filter((row) => row.item.platform === query.platform),
  );
  const assemble = vi.fn<CatalogCardEntry['assemble']>(async (input) => {
    if (failing.has(input.ref.productKey)) throw new Error('synthetic quote timeout');
    const row = rows.find((r) => r.ref.productKey === input.ref.productKey)!;
    const { link_id, ...unlinked } = card(row);
    return {
      kind: 'prepared',
      card: unlinked,
      commit: async () => {
        registered.push(input.ref.productKey);
        return { ...unlinked, link_id };
      },
    };
  });
  const deps: SearchProductsDeps = {
    clock: new FixedClock(NOW),
    config: {
      configValue: async (_app, key) =>
        key.startsWith('search.enabled.') ? { value: true, version: 1 } : null,
    },
    platforms: ['taobao', 'jd'],
    searchProducts,
    cardEntry: () => ({ assemble }),
    prohibited: async () => false,
    categoryAllowed: async () => true,
    newResultSetId: () => 'synthetic-results',
    cardReference: (_c, index) => `c${index + 1}`,
  };
  return { deps, registered, searchProducts };
}

function listKeys(cards: readonly { type: string; data: Readonly<Record<string, unknown>> }[]) {
  const list = cards.find((c) => c.type === 'product_list');
  return ((list?.data['items'] as { product_key: string }[] | undefined) ?? []).map(
    (item) => item.product_key,
  );
}

describe('search_products price range', () => {
  // BR-AI-08: the clarify / drop-after-one-ask handling belongs to B3-05g, not this tool.
  it('min greater than max: no upstream call, no registration, price_range_invalid', async () => {
    const h = setup([candidate('tb:synthetic-a', 'taobao')], new Set());
    const outcome = await createSearchProductsHandler(h.deps).run(
      { q: '合成商品', price_min_fen: 2000, price_max_fen: 1000 },
      ctx(),
    );
    expect(outcome).toEqual({ kind: 'ok', modelView: { error: 'price_range_invalid' }, cards: [] });
    expect(h.searchProducts).not.toHaveBeenCalled();
    expect(h.registered).toEqual([]);
  });

  it('equal bounds still search', async () => {
    const h = setup([candidate('tb:synthetic-a', 'taobao')], new Set());
    const outcome = await createSearchProductsHandler(h.deps).run(
      { q: '合成商品', price_min_fen: 1000, price_max_fen: 1000 },
      ctx(),
    );
    expect(outcome.kind === 'ok' && listKeys(outcome.cards)).toEqual(['tb:synthetic-a']);
  });
});

describe('assembly failure isolation', () => {
  const rows = [
    candidate('tb:synthetic-bad', 'taobao'),
    candidate('tb:synthetic-good', 'taobao'),
    candidate('jd:synthetic-a', 'jd'),
  ];

  it('a failing quote drops only that item; other items and platforms deliver', async () => {
    const h = setup(rows, new Set(['tb:synthetic-bad']));
    const outcome = await createSearchProductsHandler(h.deps).run({ q: '合成商品' }, ctx());
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(listKeys(outcome.cards)).toEqual(['jd:synthetic-a', 'tb:synthetic-good']);
    expect(h.registered.toSorted()).toEqual(['jd:synthetic-a', 'tb:synthetic-good']);
  });

  it('keyword search: a platform whose items all fail is ok=false, the other stays ok', async () => {
    const h = setup(rows, new Set(['tb:synthetic-bad', 'tb:synthetic-good']));
    const result = await createKeywordSearch(h.deps).searchKeyword(
      { q: '合成商品', platforms: ['taobao', 'jd'], sort: 'relevance' },
      keywordCtx(),
    );
    expect(result.results).toEqual([
      { platform: 'taobao', ok: false },
      {
        platform: 'jd',
        ok: true,
        items: [expect.objectContaining({ product_key: 'jd:synthetic-a' })],
      },
    ]);
    expect(listKeys(result.cards)).toEqual(['jd:synthetic-a']);
    expect(h.registered).toEqual(['jd:synthetic-a']);
  });

  it('keyword search: every platform failing to assemble is all-failed, not empty success', async () => {
    const h = setup(rows, new Set(rows.map((r) => r.ref.productKey)));
    const result = await createKeywordSearch(h.deps).searchKeyword(
      { q: '合成商品', platforms: ['taobao', 'jd'], sort: 'relevance' },
      keywordCtx(),
    );
    expect(result.results).toEqual([
      { platform: 'taobao', ok: false },
      { platform: 'jd', ok: false },
    ]);
    expect(result.cards).toEqual([]);
    expect(h.registered).toEqual([]);
  });
});

describe('card references (B3-05i: index addresses outcome.cards)', () => {
  it('a middle item failing to assemble: later items reference the list card in outcome.cards', async () => {
    const rows = [
      candidate('tb:synthetic-1', 'taobao'),
      candidate('tb:synthetic-2', 'taobao'),
      candidate('tb:synthetic-3', 'taobao'),
    ];
    const h = setup(rows, new Set(['tb:synthetic-2']));
    const indices: number[] = [];
    const deps: SearchProductsDeps = {
      ...h.deps,
      cardReference: (_c, index) => {
        indices.push(index);
        return `@ref:${index}`;
      },
    };
    const outcome = await createSearchProductsHandler(deps).run(
      { q: '合成商品', platforms: ['taobao'] },
      ctx(),
    );
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.cards.map((c) => c.type)).toEqual(['product_list']);
    expect(listKeys(outcome.cards)).toEqual(['tb:synthetic-1', 'tb:synthetic-3']);
    const view = outcome.modelView as { items: { card_id: string; title: string }[] };
    expect(view.items.map((item) => item.card_id)).toEqual(['@ref:0', '@ref:0']);
    expect(view.items.map((item) => item.title)).toEqual([
      '<untrusted>合成商品 tb:synthetic-1</untrusted>',
      '<untrusted>合成商品 tb:synthetic-3</untrusted>',
    ]);
    // Never an index past outcome.cards, never one for the dropped item.
    expect(indices.every((index) => index >= 0 && index < outcome.cards.length)).toBe(true);
    expect(indices).toHaveLength(2);
  });
});
