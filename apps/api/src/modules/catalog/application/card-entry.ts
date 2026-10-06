// B1-05i: the single card entry of catalog. It splits the request purpose by D33 price state:
// retrieval (search, feeds, Agent retrieval) skips a price-anomaly item; an active query (detail,
// parse, rebate_quote, open re-check) fails closed with price_unavailable. Either way the anomaly
// is logged once as PRICE_ANOMALY here (BR-PRICE-01); union already logs PRICE_CALC_DIFF /
// PRICE_PROMO_UNKNOWN and those are not repeated.
import type { Logger } from 'pino';
import { isPriceAnomaly } from '../../union/index.ts';
import {
  createCardAssembler,
  type AssembleCardInput,
  type CardAssemblerOptions,
  type ProductCard,
} from './card-assembler.ts';

/** The request's purpose is independent of its inherited link entry_source. */
export type CatalogCardScene = 'retrieval' | 'active_query';

export interface CatalogCardInput extends AssembleCardInput {
  readonly scene: CatalogCardScene;
}

/** Internal result, not a replacement for the wire ProductCard contract. */
export type CatalogCardResult =
  | { readonly kind: 'card'; readonly card: ProductCard }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'price_unavailable' };

export interface CatalogCardEntryOptions extends CardAssemblerOptions {
  /** Emit a flat warning with code PRICE_ANOMALY at the anomaly decision. */
  readonly logger: Pick<Logger, 'warn'>;
}

export interface CatalogCardEntry {
  assemble(input: CatalogCardInput): Promise<CatalogCardResult>;
}

// TODO(规划/11 §9.2): price_unavailable 卡（availability=price_unavailable，文案「暂时查不到该商品价格」、
// 按钮「稍后再试」，不带金额与 link_id）的线上形状 — blocked on followups F-37 契约同步。
/**
 * B1-05i: the common card entry for retrieval and active price queries. The anomaly check uses
 * union's isPriceAnomaly only (price_status = anomaly, or the three fields failing BR-PRICE-01,
 * for every platform) and runs before any viewer, quote, item_ref or link work, so an anomaly
 * never registers a link, invents a link_id or exposes an amount. Nothing is cached between
 * calls: a later valid price assembles and registers a fresh card. Failures other than a price
 * anomaly (quote, item_ref, link registration) still reject the call unchanged.
 */
export function createCatalogCardEntry(options: CatalogCardEntryOptions): CatalogCardEntry {
  const { logger } = options;
  const assembler = createCardAssembler(options);

  async function assemble(input: CatalogCardInput): Promise<CatalogCardResult> {
    const { item, scene } = input;
    if (isPriceAnomaly(item)) {
      // Flat fields only, no viewer data and no amounts (the fields may be missing or wrong).
      logger.warn(
        {
          code: 'PRICE_ANOMALY',
          scene,
          platform: item.platform,
          product_key: input.ref.productKey,
          price_status: item.price_status === 'anomaly' ? 'anomaly' : 'invalid_fields',
        },
        'catalog: price anomaly, card not issued',
      );
      return scene === 'retrieval' ? { kind: 'skipped' } : { kind: 'price_unavailable' };
    }
    const card = await assembler.assemble(input);
    return { kind: 'card', card };
  }

  return { assemble };
}
