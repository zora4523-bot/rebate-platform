// B1-28b rule-test helpers (favorites use cases; 规划/04 §3.2 favorites, §6.3; BR-ID-30 ⑱;
// orchestrator semantics B.1–B.6). Everything under test comes from the public catalog/index.ts;
// expectations in the tests are literals or derived by the tests themselves.
import type {
  CatalogConfigReader,
  FavoriteCardOutcome,
  FavoriteCardPort,
  FavoriteCardRequest,
  ProductCard,
} from '../../../../apps/api/src/modules/catalog/index.ts';

/** The configuration key of the per-user cap (规划/04 §3.2 favorites). */
export const CAP_KEY = 'favorites.max_per_user';

/** An instant of the example day in Beijing time, e.g. at('08:00'). */
export function at(hhmm: string, day = '2031-05-20'): Date {
  return new Date(`${day}T${hhmm}:00.000+08:00`);
}

/** A complete priced list card (search shape) for a product key. */
export function pricedCard(productKey: string, overrides: Partial<ProductCard> = {}): ProductCard {
  return {
    product_key: productKey,
    item_ref: `fav-ref-${productKey}`,
    platform: 'taobao',
    shop_type: null,
    title: `收藏演示 ${productKey}`,
    image: 'https://example.com/fav.png',
    shop_name: null,
    price_fen: 3990,
    coupon_fen: 1000,
    final_price_fen: 2990,
    est_net_price_fen: 2890,
    rebate_min_fen: 100,
    rebate_max_fen: 100,
    rebate_basis: 'normal',
    benefit_tags: ['有券'],
    is_presale: false,
    link_id: '019a0000-0000-7000-8000-00000000f001',
    cta: { text_key: 'btn.buy.coupon' },
    quoted_at: '2031-05-20T08:00:00+08:00',
    stale: false,
    age_sec: 0,
    source: 'taobao_union',
    disclaimer_keys: ['price_basis'],
    ad_label: null,
    availability: 'ok',
    ...overrides,
  };
}

/** A configuration reader (plain functions, no vi.fn) answering `value` for the cap key. */
export function capConfig(
  value: unknown,
  options: { fail?: boolean; appId?: string } = {},
): CatalogConfigReader & { calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    async configValue(appId: string, key: string) {
      calls.push([appId, key]);
      if (options.fail === true) throw new Error('config store down');
      if (key !== CAP_KEY || value === undefined) return null;
      if (options.appId !== undefined && appId !== options.appId) return null;
      return { value: value as never, version: 1 };
    },
  };
}

/** A card port answering per product key (default: a priced card); `throws` keys reject. */
export function cardPort(
  answers: ReadonlyMap<string, FavoriteCardOutcome> = new Map(),
  throws: ReadonlySet<string> = new Set(),
): FavoriteCardPort & { requests: FavoriteCardRequest[] } {
  const requests: FavoriteCardRequest[] = [];
  return {
    requests,
    async fetch(request) {
      requests.push(request);
      if (throws.has(request.productKey)) throw new Error('union detail timed out');
      return (
        answers.get(request.productKey) ?? { kind: 'card', card: pricedCard(request.productKey) }
      );
    },
  };
}

/** A warn sink (plain function). */
export function warnSink(): { warn: (...args: unknown[]) => void; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    warn: (...args: unknown[]) => {
      calls.push(args);
    },
  };
}

/** How a promise settled, without letting a rejection escape. */
export async function settled<T>(
  run: () => Promise<T>,
): Promise<{ kind: 'returned'; value: T } | { kind: 'rejected'; error: unknown }> {
  try {
    return { kind: 'returned', value: await run() };
  } catch (error) {
    return { kind: 'rejected', error };
  }
}
