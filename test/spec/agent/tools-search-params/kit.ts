import { expect, vi } from 'vitest';
import type {
  CatalogCardEntry,
  ProductCard,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type {
  ToolContext,
  ToolOutcome,
} from '../../../../apps/api/src/modules/agent/orchestrator/index.ts';
import { createToolRegistry } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import {
  createSearchProductsHandler,
  type AgentSearchCandidate,
  type SearchProductsDeps,
} from '../../../../apps/api/src/modules/agent/tools/search/index.ts';

// B3-04b kit 的精简合成夹具；不改受保护目录，不涉及真实平台报文。
const NOW = '2026-10-17T12:00:00+08:00';
export type Platform = AgentSearchCandidate['item']['platform'];

export function candidate(key: string, title: string, platform: Platform): AgentSearchCandidate {
  return {
    item: {
      platform,
      item_id: key,
      title,
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
      title,
      shopId: null,
      shopType: null,
      source: 'search',
    },
    sales: 10,
    categoryId: 'synthetic-allowed-category',
  };
}

function card(row: AgentSearchCandidate): ProductCard {
  return {
    product_key: row.ref.productKey,
    item_ref: `synthetic-ref-${row.ref.productKey}`,
    platform: row.item.platform,
    shop_type: null,
    title: row.item.title,
    image: 'https://example.invalid/synthetic.png',
    shop_name: '合成店铺',
    price_fen: 1000,
    coupon_fen: 0,
    final_price_fen: 1000,
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
    quoted_at: NOW,
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
  };
}

export function fixture(rows: readonly AgentSearchCandidate[] = []) {
  const settings = new Map<string, boolean>([
    ['search.enabled.taobao', true],
    ['search.enabled.jd', true],
    ['search.enabled.pdd', true],
  ]);
  const searchProducts = vi.fn<SearchProductsDeps['searchProducts']>(async (query) =>
    rows.filter((row) => row.item.platform === query.platform),
  );
  const assemble = vi.fn<CatalogCardEntry['assemble']>(async (input) => {
    const row = rows.find((entry) => entry.ref.productKey === input.ref.productKey)!;
    const full = card(row);
    if (input.deferLink !== true) return { kind: 'card', card: full };
    const { link_id, ...unlinked } = full;
    void link_id;
    return { kind: 'prepared', card: unlinked, commit: async () => full };
  });
  const deps: SearchProductsDeps = {
    clock: new FixedClock(NOW),
    config: {
      configValue: async (_app, key) => {
        const value = settings.get(key);
        return value === undefined ? null : { value, version: 1 };
      },
    },
    platforms: ['taobao', 'jd', 'pdd'],
    searchProducts,
    cardEntry: () => ({ assemble }),
    prohibited: async () => false,
    categoryAllowed: async () => true,
    newResultSetId: () => 'synthetic-result-set',
    cardReference: () => 'c12',
  };
  const handler = createSearchProductsHandler(deps);
  const run = vi.fn(handler.run.bind(handler));
  const registry = createToolRegistry({
    handlers: [{ ...handler, run }],
    switches: { get: async () => true },
  });
  const ctx: ToolContext = {
    subject: {
      appId: 'synthetic-app',
      userId: 'synthetic-user',
      deviceId: 'synthetic-device',
      phoneBound: true,
      deviceHash: 'synthetic-hash',
      ipKey: 'synthetic-ip',
      traceId: 'synthetic-trace',
    },
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    placeholders: {},
  };
  return {
    settings,
    searchProducts,
    run,
    execute: (args: Readonly<Record<string, unknown>>) =>
      registry.execute({ id: 'synthetic-call', name: 'search_products', args }, ctx),
  };
}

export function keys(outcome: ToolOutcome): string[] {
  expect(outcome.kind).toBe('ok');
  if (outcome.kind !== 'ok') return [];
  const lists = outcome.cards.filter((entry) => entry.type === 'product_list');
  expect(lists).toHaveLength(1);
  const data = lists[0]?.data as { items: ProductCard[] } | undefined;
  return data?.items.map((entry) => entry.product_key!) ?? [];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 只读实际端口入参，不从请求或默认值补页号；允许 query 字段或额外页号参数。 */
export function portPage(args: readonly unknown[]): unknown {
  for (const arg of args) {
    if (typeof arg === 'number') return arg;
    const object = record(arg);
    const page = object?.['page'] ?? object?.['page_no'] ?? object?.['pageNo'];
    if (page !== undefined) return page;
  }
  return undefined;
}

/** trace 可嵌套，也可使用等价服务端元数据；不把卡片或 modelView 当成编排元数据。 */
export function effectiveValues(outcome: ToolOutcome, key: 'spec' | 'page'): unknown[] {
  const metadata = Object.fromEntries(
    Object.entries(outcome).filter(
      ([name]) => !['kind', 'modelView', 'cards', 'suggestions'].includes(name),
    ),
  );
  const values: unknown[] = [];
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const object = record(value);
    if (object === undefined) return;
    for (const [name, child] of Object.entries(object)) {
      if (name === key || (key === 'page' && ['page_no', 'pageNo'].includes(name)))
        values.push(child);
      else visit(child);
    }
  }
  visit(metadata);
  return values;
}
