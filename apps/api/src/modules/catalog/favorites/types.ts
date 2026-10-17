// B1-28b: shared types of the favorites use cases (规划/04 §3.2 favorites, §6.3; BR-ID-30 ⑱).
// Leaf file: no imports from catalog/index.ts. Rule tests: test/spec/catalog/favorites/**.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Clock } from '../../platform/index.ts';
import type { ProductCard } from '../application/card-assembler.ts';
import type { CatalogConfigReader, Viewer } from '../ports.ts';

/** One product reference of a favorite (batch delete item; also the unique key inside a user). */
export interface FavoriteKey {
  readonly platform: string;
  readonly productKey: string;
}

/** A stored favorite: only the product reference and the time (no price, link or password). */
export interface FavoriteRecord {
  readonly id: string;
  readonly platform: string;
  readonly productKey: string;
  /** app.favorites.created_at, written from the injected Clock. */
  readonly favoritedAt: Date;
}

/** The decoded list cursor: the last row of the previous page. */
export interface FavoritesCursor {
  readonly createdAt: Date;
  readonly id: string;
}

/** Why the union says a favorite's product cannot be shown as a priced card. */
export type FavoriteUnavailableReason = 'not_found' | 'off_shelf' | 'not_promotable';

/**
 * What the card port answers for one favorite: a priced list card (same shape as search, link
 * and quote snapshot registered, never converted), or the union's "not found / off shelf / not
 * promotable" with whatever title and image are still known.
 */
export type FavoriteCardOutcome =
  | { readonly kind: 'card'; readonly card: ProductCard }
  | {
      readonly kind: 'unavailable';
      readonly reason: FavoriteUnavailableReason;
      readonly title: string | null;
      readonly image: string | null;
    };

export interface FavoriteCardRequest {
  readonly viewer: Viewer;
  readonly platform: string;
  readonly productKey: string;
}

/**
 * The injectable card port (scene retrieval). The real one is built on catalog's
 * createCatalogCardEntry and product reading; tests use a stand-in, never a union.
 */
export interface FavoriteCardPort {
  fetch(request: FavoriteCardRequest): Promise<FavoriteCardOutcome>;
}

/** The card of an invalid favorite: title and image only, no price and no rebate_*. */
export interface FavoriteInvalidCard {
  readonly title: string | null;
  readonly image: string | null;
}

export type FavoriteCardView =
  | { readonly invalid: false; readonly productCard: ProductCard }
  | { readonly invalid: true; readonly productCard: FavoriteInvalidCard };

export type FavoriteListItem = {
  readonly platform: string;
  readonly productKey: string;
  readonly favoritedAt: Date;
} & FavoriteCardView;

export interface FavoritesPage {
  /** Newest first: created_at DESC, id DESC; at most 20 items. */
  readonly items: readonly FavoriteListItem[];
  /** Opaque; null when there is no further page. */
  readonly nextCursor: string | null;
}

/** The logged-in viewer of the list (the card port prices per viewer). */
export interface FavoritesViewer extends Viewer {
  readonly userId: string;
}

export interface FavoritesServiceOptions {
  /** A couli_app connection (schema app). */
  readonly db: Kysely<DB>;
  readonly clock: Clock;
  /** favorites.max_per_user is read through it, per app. */
  readonly config: CatalogConfigReader;
  readonly cards: FavoriteCardPort;
  /** A card port failure is logged here (flat fields) and the item shown as invalid. */
  readonly logger: Pick<Logger, 'warn'>;
}

/**
 * The favorites use cases; every query is scoped by app_id. Called inside
 * runInFavoritesTransaction (B1-28e), the writes use that transaction (per-user lock first, then
 * the reads and writes) instead of opening their own; otherwise each opens one.
 */
export interface FavoritesService {
  /**
   * Existing (app_id, user_id, platform, product_key) → the original record, nothing written.
   * Otherwise, in one transaction serialised per (app_id, user_id): count ≥ cap → FavoriteError
   * 20001 reason favorites_full; else insert with created_at from the Clock. A concurrent insert
   * of the same product (23505) also returns the original record.
   */
  addFavorite(
    appId: string,
    userId: string,
    platform: string,
    productKey: string,
  ): Promise<FavoriteRecord>;
  /** Deletes the row; succeeds when there is none. */
  removeFavorite(
    appId: string,
    userId: string,
    platform: string,
    productKey: string,
  ): Promise<void>;
  /** At most 100 items (more → FavoriteError 20001 fields [items], nothing deleted). */
  removeFavorites(appId: string, userId: string, items: readonly FavoriteKey[]): Promise<void>;
  /** One page of 20; cursor null for the first page; an undecodable cursor → 20001. */
  listFavorites(viewer: FavoritesViewer, cursor: string | null): Promise<FavoritesPage>;
  /** false for a guest (userId null). */
  isFavorited(
    appId: string,
    userId: string | null,
    platform: string,
    productKey: string,
  ): Promise<boolean>;
  /** Account deletion completed (BR-ID-30 ⑱): every favorite of the user in the app. */
  deleteAllFavoritesOfUser(appId: string, userId: string): Promise<void>;
}
