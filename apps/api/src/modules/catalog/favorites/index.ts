// B1-28b: favorites use cases (规划/04 §3.2 favorites, §6.3; BR-ID-30 ⑱); re-exported by
// catalog/index.ts. No route here (B1-28c). Rule tests: test/spec/catalog/favorites/**.
export { FavoriteError } from './errors.ts';
export type { FavoriteErrorData } from './errors.ts';
export { decodeFavoritesCursor, encodeFavoritesCursor } from './cursor.ts';
export { favoriteCardView, readFavoritesCap } from './rules.ts';
export { createFavoritesService } from './service.ts';
export { createFavoriteCardPort } from './card-port.ts';
// B1-28f: the deletion cleanup port (identity's deletionCleanupPorts.catalog).
export { deleteFavoritesForUser } from './deletion.ts';
export type { FavoritesDeletionInput } from './deletion.ts';
export {
  outerFavoritesTransaction,
  prefetchedFavoritesCap,
  runInFavoritesTransaction,
} from './transaction.ts';
export type { PrefetchedFavoritesCap } from './transaction.ts';
export type { FavoriteCardPortOptions } from './card-port.ts';
export type {
  FavoriteCardOutcome,
  FavoriteCardPort,
  FavoriteCardRequest,
  FavoriteCardView,
  FavoriteInvalidCard,
  FavoriteKey,
  FavoriteListItem,
  FavoriteRecord,
  FavoritesCursor,
  FavoritesPage,
  FavoritesService,
  FavoritesServiceOptions,
  FavoritesViewer,
  FavoriteUnavailableReason,
} from './types.ts';
