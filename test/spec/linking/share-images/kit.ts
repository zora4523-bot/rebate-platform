// B1-15z rule-test kit: shares a product through the real api entry (the B1-15w kit,
// test/spec/linking/shares/kit.ts, used as it is) and pairs the answer with the union detail that
// very request read. Only *.int.test.ts import @couli/db/testing; they hand the harness in.
import { expect } from 'vitest';
import {
  bodyOf,
  expectShared,
  validate,
  type InjectResponse,
  type ProductCard,
  type ShareMaterials,
  type SharePlatform,
  type Sharer,
  type SharesHarness,
  type UnionItemDetail,
} from '../shares/kit.ts';

export interface SharedProduct {
  readonly card: ProductCard;
  readonly data: ShareMaterials;
  /** What the demo adapter's getItem returned to this share. */
  readonly detail: UnionItemDetail;
}

/** The cards of a search page that can be shared. */
export function shareable(cards: readonly ProductCard[]): ProductCard[] {
  const found = cards.filter((card) => card.product_key !== null);
  expect(found.length).toBeGreaterThan(0);
  return found;
}

/** One 200 share of the card that passes the contract, with its union detail. */
export async function shareCard(
  h: SharesHarness,
  sharer: Sharer,
  card: ProductCard,
): Promise<SharedProduct> {
  h.clearObservations();
  const data = await expectShared(await sharer.share(bodyOf(card)));
  const detail = h.items().at(-1);
  expect(detail, 'the union detail this share read').toBeDefined();
  return { card, data, detail: detail! };
}

/**
 * The first product of a search page whose detail has a main image and a gallery, shared; its
 * response must carry images. Every first search result of the demo has no image at all.
 */
export async function sharedWithImages(
  h: SharesHarness,
  sharer: Sharer,
  platform: SharePlatform,
): Promise<SharedProduct> {
  let found: SharedProduct | undefined;
  for (const card of shareable(await sharer.search(platform))) {
    const shared = await shareCard(h, sharer, card);
    const { main_image_url: main, image_urls: gallery } = shared.detail;
    if (main !== undefined && gallery !== undefined) {
      found = shared;
      break;
    }
  }
  expect(found, 'a product with a main image and a gallery').toBeDefined();
  expect(found!.data.images.length).toBeGreaterThan(0);
  return found!;
}

/** A refused share that passes the contract and carries neither `images` nor these addresses. */
export async function expectNoImages(
  response: InjectResponse,
  urls: readonly string[],
): Promise<void> {
  expect(response.statusCode, response.payload).toBeGreaterThanOrEqual(400);
  const body = response.json() as { readonly code: number; readonly data?: object };
  expect(body.code).not.toBe(0);
  await validate(body, 'ErrorEnvelope');
  expect(body).not.toHaveProperty('images');
  expect(body.data ?? {}).not.toHaveProperty('images');
  for (const url of urls) expect(response.payload).not.toContain(url);
}
