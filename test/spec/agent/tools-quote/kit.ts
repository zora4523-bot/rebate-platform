import { expect, vi } from 'vitest';
import {
  createCatalogCardEntry,
  type CatalogCardInput,
  type ProductCard,
  type RebateQuote,
  type RegisterLinkInput,
} from '../../../../apps/api/src/modules/catalog/index.ts';
import type { ParsedUrlProduct } from '../../../../apps/api/src/modules/parsing/index.ts';
import { FixedClock } from '../../../../apps/api/src/modules/platform/index.ts';
import type { CallCtx, UnionItem } from '../../../../apps/api/src/modules/union/index.ts';
import type { ToolCallContext } from '../../../../apps/api/src/modules/agent/tools/registry/index.ts';
import type {
  QuoteReference,
  QuoteReferenceResult,
  RebateQuoteDeps,
} from '../../../../apps/api/src/modules/agent/tools/quote/index.ts';
import type { UnnumberedCard } from '../../../../apps/api/src/modules/agent/stream/run/index.ts';
import { createFrameValidator } from '../../../../apps/api/src/modules/agent/stream/writer/index.ts';

// Entirely synthetic domain DTOs; no platform recording, real URL, credentials or I/O.
export const productKey = 'jd:synthetic-quote';
export const candidate = {
  kind: 'url' as const,
  raw: 'https://example.invalid/synthetic-product',
  index: 0,
};

export function context(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    appId: 'synthetic-app',
    userId: 'synthetic-user',
    deviceId: 'synthetic-device',
    phoneBound: true,
    runId: 'synthetic-run',
    sessionId: 'synthetic-session',
    signal: new AbortController().signal,
    placeholders: {},
    ...overrides,
  };
}

export function fixture() {
  const clock = new FixedClock('2026-10-15T00:00:00.000Z');
  let current: ParsedUrlProduct = {
    item: {
      platform: 'jd',
      itemId: 'synthetic-quote',
      title: '合成报价商品',
      price_fen: 3990n,
      coupon_fen: 1000n,
      final_price_fen: 2990n,
      commission_rate_bp: 1000n,
      quoted_at: '2026-10-15T08:00:00+08:00',
    },
    ref: {
      appId: 'synthetic-app',
      platform: 'jd',
      productKey,
      rawItemId: 'synthetic-quote',
      rawFetchedAt: '2026-10-15T08:00:00+08:00',
      receivedAt: clock.now().toISOString(),
      canonicalUrl: null,
      title: '合成报价商品',
      shopId: null,
      shopType: null,
      source: 'parse',
    },
  };
  let quoteValue: RebateQuote = {
    rebateMinFen: 137n,
    rebateMaxFen: 137n,
    estNetPriceFen: 2853n,
    rebateBasis: 'normal',
  };
  const reads: string[] = [];
  const parseUrl = vi.fn(async (_url: string, _ctx: CallCtx) => {
    void _url;
    void _ctx;
    reads.push(clock.now().toISOString());
    return current;
  });
  const readProduct = vi.fn(async (_key: string, _ctx: ToolCallContext) => {
    void _key;
    void _ctx;
    reads.push(clock.now().toISOString());
    return current;
  });
  const register = vi.fn(async (_input: RegisterLinkInput) => {
    void _input;
    return { linkId: 'synthetic-link' };
  });
  const quote = vi.fn(async (_item: UnionItem) => {
    void _item;
    return quoteValue;
  });
  // Exposed on the doubles to catch attempts to use a conversion/open operation.
  const convert = vi.fn(async () => ({ url: 'https://example.invalid/forbidden-conversion' }));
  const openLink = vi.fn(async () => ({ url: 'https://example.invalid/forbidden-open' }));
  const commits = vi.fn();
  let cardPatch: Record<string, unknown> = {};
  const assemble = vi.fn(async (input: CatalogCardInput, ctx: ToolCallContext) => {
    const entry = createCatalogCardEntry({
      clock,
      viewerContext: { current: async () => ctx },
      quoter: { quote },
      registrar: { register },
      sourceLinks: { entrySource: async () => 'agent' },
      itemRefs: { issue: () => 'synthetic-item-ref' },
      logger: { warn: vi.fn() },
    });
    const result = await entry.assemble(input);
    if (result.kind === 'prepared') {
      return {
        ...result,
        card: { ...result.card, ...cardPatch },
        async commit() {
          commits();
          return { ...(await result.commit()), ...cardPatch } as ProductCard;
        },
      };
    }
    return result;
  });
  const resolve = vi.fn(
    async (_ref: QuoteReference, _ctx: ToolCallContext): Promise<QuoteReferenceResult> => {
      void _ref;
      void _ctx;
      return { kind: 'product', productKey };
    },
  );
  const parsing = { parseUrl, convert };
  const catalog = {
    readProduct,
    cards: (ctx: ToolCallContext) => ({
      assemble: (input: CatalogCardInput) => assemble(input, ctx),
    }),
    convert,
    openLink,
  };
  const deps: RebateQuoteDeps = { parsing, catalog, references: { resolve } };
  return {
    deps,
    clock,
    parseUrl,
    readProduct,
    register,
    quote,
    convert,
    openLink,
    assemble,
    resolve,
    commits,
    reads,
    get current() {
      return current;
    },
    setProduct(value: ParsedUrlProduct) {
      current = value;
    },
    setQuote(value: RebateQuote) {
      quoteValue = value;
    },
    patchCard(value: Record<string, unknown>) {
      cardPatch = value;
    },
  };
}

export function productOf(cards: readonly UnnumberedCard[]): Record<string, unknown> {
  expect(cards).toHaveLength(1);
  const card = cards[0];
  expect(card).toMatchObject({ type: 'rebate_quote', schema_version: 1 });
  expect(card).not.toHaveProperty('card_id');
  const data = card?.data as Record<string, unknown>;
  expect(data).toMatchObject({ material: null, tlj_kind: 'unknown' });
  const product = data['product'] as Record<string, unknown>;
  expect(product).not.toHaveProperty('card_id');
  // Validate the real wire contract after adding only the IDs owned by stream/run.
  expect(
    createFrameValidator()({
      event: 'card',
      id: 1,
      data: {
        ...card,
        seq: 1,
        card_id: 'c1',
        data: { ...data, product: { ...product, card_id: 'c2' } },
      },
    }),
  ).toEqual({ ok: true });
  return product;
}

/** BR-AI-05: check the complete projection, not just a blacklist of known amount names.
 * Numbering belongs to stream/run; this tool must not allocate a fresh session number.
 */
export function expectSafeView(
  view: unknown,
  expectedTitle = '<untrusted>合成报价商品</untrusted>',
) {
  const objects: Record<string, unknown>[] = [];
  function visit(value: unknown): void {
    expect(typeof value).not.toBe('number');
    expect(typeof value).not.toBe('bigint');
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value !== null && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      objects.push(record);
      Object.values(record).forEach(visit);
    }
  }
  visit(view);
  const products = objects.filter((value) => 'title' in value);
  expect(products).toHaveLength(1);
  expect(products[0]).toMatchObject({
    title: expectedTitle,
    platform: 'jd',
    benefit_tags: ['有券'],
  });
  for (const value of objects) {
    const allowed =
      'title' in value ? ['card_id', 'title', 'platform', 'benefit_tags'] : ['products'];
    expect(Object.keys(value).every((key) => allowed.includes(key))).toBe(true);
  }
  expect(JSON.stringify(view)).not.toContain('https://');
  expect(JSON.stringify(view)).not.toContain(productKey);
  expect(JSON.stringify(view)).not.toContain('synthetic-link');
}
