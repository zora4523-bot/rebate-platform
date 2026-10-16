// B1-28b: the opaque keyset cursor of the favorites list (created_at + id of the last row).
import { FixedClock } from '../../platform/index.ts';
import type { FavoritesCursor } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An opaque string; decodeFavoritesCursor gives back the same instant and id. */
export function encodeFavoritesCursor(cursor: FavoritesCursor): string {
  return Buffer.from(
    JSON.stringify(['favorites.v1', cursor.createdAt.toISOString(), cursor.id]),
  ).toString('base64url');
}

/** null for anything that is not a cursor of encodeFavoritesCursor; never throws. */
export function decodeFavoritesCursor(value: string): FavoritesCursor | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [version, instant, id] = parsed as unknown[];
    if (
      version !== 'favorites.v1' ||
      typeof instant !== 'string' ||
      typeof id !== 'string' ||
      !UUID.test(id)
    )
      return null;
    // Parse the cursor's fixed instant through the clock module; never read wall time.
    const createdAt = new FixedClock(instant).now();
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== instant) return null;
    const cursor = { createdAt, id };
    return encodeFavoritesCursor(cursor) === value ? cursor : null;
  } catch {
    return null;
  }
}
