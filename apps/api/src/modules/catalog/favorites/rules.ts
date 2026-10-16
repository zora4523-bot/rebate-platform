// B1-28b: pure parts of the favorites use cases: the per-user cap and the invalid-card decision.
import type { CatalogConfigReader } from '../ports.ts';
import type { FavoriteCardOutcome, FavoriteCardView } from './types.ts';

/**
 * favorites.max_per_user of the app, read through config.configValue(appId, key); 200 when the
 * entry is missing, its value is not a positive safe integer, or the read fails. Never rejects.
 */
export async function readFavoritesCap(
  config: CatalogConfigReader,
  appId: string,
): Promise<number> {
  try {
    const entry = await config.configValue(appId, 'favorites.max_per_user');
    const value = entry?.value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  } catch {
    // A configuration outage must not disable favorites.
  }
  return 200;
}

/**
 * The list view of one card outcome: unavailable, or a card whose availability is off_shelf →
 * invalid with a card of exactly { title, image }; any other card is passed through unchanged.
 */
export function favoriteCardView(outcome: FavoriteCardOutcome): FavoriteCardView {
  if (outcome.kind === 'unavailable' || outcome.card.availability === 'off_shelf') {
    const source = outcome.kind === 'unavailable' ? outcome : outcome.card;
    return { invalid: true, productCard: { title: source.title, image: source.image } };
  }
  return { invalid: false, productCard: outcome.card };
}
