// B1-28b: pure parts of the favorites use cases: the per-user cap and the invalid-card decision.
import type { CatalogConfigReader } from '../ports.ts';
import type { FavoriteCardOutcome, FavoriteCardView } from './types.ts';

/**
 * favorites.max_per_user of the app, read through config.configValue(appId, key); 200 when the
 * entry is missing, its value is not a positive safe integer, or the read fails. Never rejects.
 */
export function readFavoritesCap(config: CatalogConfigReader, appId: string): Promise<number> {
  void config;
  void appId;
  throw new Error('NotImplemented: readFavoritesCap');
}

/**
 * The list view of one card outcome: unavailable, or a card whose availability is off_shelf →
 * invalid with a card of exactly { title, image }; any other card is passed through unchanged.
 */
export function favoriteCardView(outcome: FavoriteCardOutcome): FavoriteCardView {
  void outcome;
  throw new Error('NotImplemented: favoriteCardView');
}
