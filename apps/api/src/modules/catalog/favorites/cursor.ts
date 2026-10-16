// B1-28b: the opaque keyset cursor of the favorites list (created_at + id of the last row).
import type { FavoritesCursor } from './types.ts';

/** An opaque string; decodeFavoritesCursor gives back the same instant and id. */
export function encodeFavoritesCursor(cursor: FavoritesCursor): string {
  void cursor;
  throw new Error('NotImplemented: encodeFavoritesCursor');
}

/** null for anything that is not a cursor of encodeFavoritesCursor; never throws. */
export function decodeFavoritesCursor(value: string): FavoritesCursor | null {
  void value;
  throw new Error('NotImplemented: decodeFavoritesCursor');
}
