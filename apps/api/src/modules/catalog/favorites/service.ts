// B1-28b: the favorites use cases on app.favorites (catalog is the single writer).
import type { FavoritesService, FavoritesServiceOptions } from './types.ts';

/** See FavoritesService. */
export function createFavoritesService(options: FavoritesServiceOptions): FavoritesService {
  void options;
  throw new Error('NotImplemented: createFavoritesService');
}
