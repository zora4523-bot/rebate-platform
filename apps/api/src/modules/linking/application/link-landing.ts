// B1-06j: GET /v1/links/{link_id}, the card of the in-app link landing page (route LinkLanding,
// BR-ATTR-05 细则「App 内打开链接的入口」). Read-only: it registers no link, writes no link_log,
// converts nothing (product fields read through catalog's read-only port, at most one union
// detail); buying still goes only through the open. The card
// is the shared subset of the share page (no rebate_*, no est_net_price_fen, BR-PRICE-06,
// BR-ATTR-10); viewer_is_sharer is only a hint (BR-ATTR-11), the open decides the identity.
import type { components } from '@couli/contracts-ts';
import type { DB } from '@couli/db';
import { addFen, fenToJsonNumber } from '@couli/money';
import type { Kysely, Selectable } from 'kysely';
import type { CatalogProductReader, ItemRefClaims, ItemRefService } from '../../catalog/index.ts';
import type { Clock, HandlerResult } from '../../platform/index.ts';
import type { CallerContext } from '../ports.ts';

export type LandingLink = Selectable<DB['links']>;

type SharedProductCard = components['schemas']['SharedProductCard'];
type LinkLandingData = components['schemas']['LinkLandingData'];

/** Read ports only: card loading must not register, open or convert a link. */
export interface LinkLandingOptions {
  readonly callerContext: CallerContext;
  readonly links: {
    find(appId: string, linkId: string): Promise<LandingLink | null>;
  };
  readonly cards: {
    /** Any card carrying at least the shared fields; only the shared subset leaves the service. */
    read(link: LandingLink): Promise<SharedProductCard>;
  };
}

/** links.link_id is a uuid column: any other value is an unknown link, never a query. */
const LINK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LinkLandingInput {
  readonly linkId: string;
  readonly traceId: string;
}

/**
 * The fields of SharedProductCard (contracts/openapi.yaml). An allowlist, so a rebate or Agent
 * field added to ProductCard later can never reach the landing page through a blocklist gap.
 */
const SHARED_CARD_FIELDS = [
  'product_key',
  'item_ref',
  'platform',
  'shop_type',
  'title',
  'image',
  'shop_name',
  'price_fen',
  'coupon_fen',
  'final_price_fen',
  'benefit_tags',
  'is_presale',
  'tlj',
  'link_id',
  'stale',
  'age_sec',
  'source',
  'disclaimer_keys',
  'ad_label',
  'availability',
] as const satisfies readonly (keyof SharedProductCard)[];

function sharedSubset(card: SharedProductCard, linkId: string): SharedProductCard {
  const source = card as unknown as Readonly<Record<string, unknown>>;
  const subset: Record<string, unknown> = {};
  for (const field of SHARED_CARD_FIELDS) {
    if (Object.hasOwn(source, field) && source[field] !== undefined) subset[field] = source[field];
  }
  // The card is the landing link's card, whatever the reader returned.
  subset['link_id'] = linkId;
  return subset as unknown as SharedProductCard;
}

/** identity_snapshot.user_id: the sharer of a share link (BR-ATTR-05 ①); null when unreadable. */
function snapshotUserId(link: LandingLink): string | null {
  const raw = link.identity_snapshot;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const userId = (raw as Record<string, unknown>)['user_id'];
  return typeof userId === 'string' && userId !== '' ? userId : null;
}

function notFound(traceId: string): HandlerResult {
  // Unknown and foreign-app links answer alike, so existence never leaks (BR-ATTR-05 ⑤).
  return { status: 404, envelope: { code: 30144, msg: '链接不存在', trace_id: traceId } };
}

export class LinkLandingService {
  readonly #options: LinkLandingOptions;

  constructor(options: LinkLandingOptions) {
    this.#options = options;
  }

  async get(input: LinkLandingInput): Promise<HandlerResult> {
    const { callerContext, links, cards } = this.#options;
    // A malformed link_id answers like an unknown one, without reaching the database (30144).
    if (typeof input.linkId !== 'string' || !LINK_ID.test(input.linkId)) {
      return notFound(input.traceId);
    }
    const caller = await callerContext.current();
    const link = await links.find(caller.appId, input.linkId);
    if (link === null || link.app_id !== caller.appId || link.link_id !== input.linkId) {
      return notFound(input.traceId);
    }
    const isShare = link.pid_scene === 'share';
    const sharer = isShare ? snapshotUserId(link) : null;
    const card = await cards.read(link);
    const data: LinkLandingData = {
      link_kind: isShare ? 'share' : 'other',
      product_card: sharedSubset(card, link.link_id),
      // From the link's quote snapshot, never from a refreshed card (BR-PRICE-11).
      quoted_at: link.quoted_at === null ? null : link.quoted_at.toISOString(),
      viewer_is_sharer: caller.userId !== null && sharer !== null && caller.userId === sharer,
    };
    return { status: 200, envelope: { code: 0, msg: 'ok', data, trace_id: input.traceId } };
  }
}

export function createLinkLanding(options: LinkLandingOptions): LinkLandingService {
  return new LinkLandingService(options);
}

/** links read in the caller's app scope; linking is the table's only reader here. */
export function createLandingLinks(db: Kysely<DB>): LinkLandingOptions['links'] {
  return {
    async find(appId: string, linkId: string): Promise<LandingLink | null> {
      const row = await db
        .selectFrom('links')
        .selectAll()
        .where('app_id', '=', appId)
        .where('link_id', '=', linkId)
        .executeTakeFirst();
      return row ?? null;
    },
  };
}

const UNION_SOURCES = {
  taobao: 'taobao_union',
  jd: 'jd_union',
  pdd: 'pdd_union',
} as const satisfies Record<string, SharedProductCard['source']>;

function isUnionPlatform(platform: string): platform is keyof typeof UNION_SOURCES {
  return Object.hasOwn(UNION_SOURCES, platform);
}

/** A snapshot price leaves only as a non-negative JSON integer (@couli/money, BR-CALC-01). */
function fenNumber(fen: bigint): number {
  if (fen < 0n) throw new RangeError('linking: negative price in the link snapshot');
  return fenToJsonNumber(fen);
}

export interface SnapshotCardOptions {
  readonly clock: Clock;
  readonly itemRefs: Pick<ItemRefService, 'issue'>;
  /** catalog's read-only product port: title and shop type (product_refs, else one union detail). */
  readonly products: Pick<CatalogProductReader, 'read'>;
}

/**
 * The landing card priced from the link's own quote snapshot: no conversion, no quote, no
 * registration.
 * Prices are the frozen quoted_final_price_fen / quoted_coupon_fen (price = final + coupon); the
 * card is marked stale because it is not re-checked here (the open re-checks, BR-PRICE-13), and
 * age_sec counts from the snapshot's quoted_at (BR-PRICE-11). Title, image, shop name and shop
 * type come from catalog's read-only product port (product_refs, else at most one governed union
 * detail; null when unreadable). A link without amounts is an amount_unknown card (availability
 * unknown).
 */
export function createSnapshotCardReader(
  options: SnapshotCardOptions,
): LinkLandingOptions['cards'] {
  const { clock, itemRefs, products } = options;
  return {
    async read(link: LandingLink): Promise<SharedProductCard> {
      const platform = link.platform;
      if (!isUnionPlatform(platform)) {
        throw new TypeError('linking: no union price source for this platform');
      }
      const product = await products.read({
        appId: link.app_id,
        platform,
        productKey: link.product_key,
        rawItemId: link.raw_item_id,
      });
      const final = link.quoted_final_price_fen;
      const coupon = link.quoted_coupon_fen;
      const priced = final !== null && coupon !== null;
      const itemRef =
        link.product_key !== null &&
        link.raw_item_id !== null &&
        link.raw_item_id !== '' &&
        link.raw_fetched_at !== null
          ? itemRefs.issue({
              appId: link.app_id,
              platform: platform as ItemRefClaims['platform'],
              productKey: link.product_key,
              rawItemId: link.raw_item_id,
              fetchedAt: link.raw_fetched_at.toISOString(),
            })
          : null;
      const quotedAtMs = link.quoted_at === null ? null : link.quoted_at.getTime();
      const nowMs = clock.now().getTime();
      const hasCoupon = coupon !== null && coupon > 0n;
      return {
        product_key: link.product_key,
        item_ref: itemRef,
        platform,
        shop_type: product.shopType,
        title: product.title,
        image: product.image,
        shop_name: product.shopName,
        price_fen: priced ? fenNumber(addFen(final, coupon)) : null,
        coupon_fen: priced ? fenNumber(coupon) : null,
        final_price_fen: priced ? fenNumber(final) : null,
        benefit_tags: hasCoupon ? ['有券'] : [],
        is_presale: false,
        link_id: link.link_id,
        stale: true,
        age_sec: quotedAtMs === null ? null : Math.max(0, Math.floor((nowMs - quotedAtMs) / 1000)),
        source: UNION_SOURCES[platform],
        // Only the price basis: no rebate key is shown to the opener (BR-PRICE-06, BR-PRICE-17).
        disclaimer_keys: [hasCoupon ? 'price_basis' : 'price_basis.general'],
        availability: priced ? 'ok' : 'unknown',
      };
    },
  };
}
