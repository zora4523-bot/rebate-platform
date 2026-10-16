// B1-28b: the favorites use cases on app.favorites (catalog is the single writer).
import { createHash, randomUUID } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { decodeFavoritesCursor, encodeFavoritesCursor } from './cursor.ts';
import { FavoriteError } from './errors.ts';
import { favoriteCardView, readFavoritesCap } from './rules.ts';
import type {
  FavoriteCardView,
  FavoriteRecord,
  FavoritesService,
  FavoritesServiceOptions,
} from './types.ts';

const PAGE_SIZE = 20;

function record(row: Selectable<DB['favorites']>): FavoriteRecord {
  return {
    id: row.id,
    platform: row.platform,
    productKey: row.product_key,
    favoritedAt: row.created_at,
  };
}

function lookup(
  db: Kysely<DB>,
  appId: string,
  userId: string,
  platform: string,
  productKey: string,
) {
  return db
    .withSchema('app')
    .selectFrom('favorites')
    .selectAll()
    .where('app_id', '=', appId)
    .where('user_id', '=', userId)
    .where('platform', '=', platform)
    .where('product_key', '=', productKey);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

/** See FavoritesService. */
export function createFavoritesService(options: FavoritesServiceOptions): FavoritesService {
  const { db, clock, config, cards, logger } = options;

  async function withUserLock<T>(
    appId: string,
    userId: string,
    work: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    // UUID text is case insensitive in PG; normalise it for the same lock identity.
    const key = createHash('sha256')
      .update(JSON.stringify(['catalog.favorites', appId, userId.toLowerCase()]))
      .digest()
      .readBigInt64BE(0);
    return db
      .transaction()
      .setIsolationLevel('read committed')
      .execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(${key.toString()}::bigint)`.execute(trx);
        return work(trx);
      });
  }

  return {
    async addFavorite(appId, userId, platform, productKey) {
      // Read configuration before holding a database connection/lock: the reader may itself
      // need a connection from the same pool. Existing records always precede the cap check.
      const cap = await readFavoritesCap(config, appId);
      try {
        return await withUserLock(appId, userId, async (trx) => {
          const existing = await lookup(
            trx,
            appId,
            userId,
            platform,
            productKey,
          ).executeTakeFirst();
          if (existing !== undefined) return record(existing);
          const table = trx.withSchema('app');
          const count = await table
            .selectFrom('favorites')
            .select((eb) => eb.fn.countAll<string>().as('n'))
            .where('app_id', '=', appId)
            .where('user_id', '=', userId)
            .executeTakeFirstOrThrow();
          if (BigInt(count.n) >= BigInt(cap)) throw new FavoriteError({ reason: 'favorites_full' });
          const row = await table
            .insertInto('favorites')
            .values({
              id: randomUUID(),
              app_id: appId,
              user_id: userId,
              platform,
              product_key: productKey,
              created_at: clock.now(),
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          return record(row);
        });
      } catch (error: unknown) {
        // A writer outside this lock can still race the unique constraint. Read only after
        // rollback (a transaction with a 23505 cannot query); never retry the insert.
        if (isUniqueViolation(error)) {
          const existing = await lookup(db, appId, userId, platform, productKey).executeTakeFirst();
          if (existing !== undefined) return record(existing);
        }
        throw error;
      }
    },

    async removeFavorite(appId, userId, platform, productKey) {
      await withUserLock(appId, userId, async (trx) => {
        await trx
          .withSchema('app')
          .deleteFrom('favorites')
          .where('app_id', '=', appId)
          .where('user_id', '=', userId)
          .where('platform', '=', platform)
          .where('product_key', '=', productKey)
          .execute();
      });
    },

    async removeFavorites(appId, userId, items) {
      if (items.length > 100) throw new FavoriteError({ fields: ['items'] });
      if (items.length === 0) return;
      await withUserLock(appId, userId, async (trx) => {
        await trx
          .withSchema('app')
          .deleteFrom('favorites')
          .where('app_id', '=', appId)
          .where('user_id', '=', userId)
          .where((eb) =>
            eb.or(
              items.map((item) =>
                eb.and([
                  eb('platform', '=', item.platform),
                  eb('product_key', '=', item.productKey),
                ]),
              ),
            ),
          )
          .execute();
      });
    },

    async listFavorites(viewer, cursor) {
      const after = cursor === null ? null : decodeFavoritesCursor(cursor);
      if (cursor !== null && after === null) throw new FavoriteError({ fields: ['cursor'] });
      let query = db
        .withSchema('app')
        .selectFrom('favorites')
        .selectAll()
        .where('app_id', '=', viewer.appId)
        .where('user_id', '=', viewer.userId);
      if (after !== null) {
        query = query.where(
          sql<boolean>`(created_at, id) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
        );
      }
      const rows = await query
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(PAGE_SIZE + 1)
        .execute();
      const page = rows.slice(0, PAGE_SIZE);
      const items = await Promise.all(
        page.map(async (row) => {
          let view: FavoriteCardView;
          try {
            view = favoriteCardView(
              await cards.fetch({ viewer, platform: row.platform, productKey: row.product_key }),
            );
          } catch {
            // Do not serialize the upstream error, viewer or raw request into logs.
            logger.warn(
              { code: 'FAVORITE_CARD_UNAVAILABLE', app_id: viewer.appId, platform: row.platform },
              'catalog: favorite card unavailable',
            );
            view = { invalid: true, productCard: { title: null, image: null } };
          }
          return {
            platform: row.platform,
            productKey: row.product_key,
            favoritedAt: row.created_at,
            ...view,
          };
        }),
      );
      const last = page.at(-1);
      return {
        items,
        nextCursor:
          rows.length > PAGE_SIZE && last !== undefined
            ? encodeFavoritesCursor({ createdAt: last.created_at, id: last.id })
            : null,
      };
    },

    async isFavorited(appId, userId, platform, productKey) {
      if (userId === null) return false;
      return (
        (await lookup(db, appId, userId, platform, productKey).executeTakeFirst()) !== undefined
      );
    },

    async deleteAllFavoritesOfUser(appId, userId) {
      await withUserLock(appId, userId, async (trx) => {
        await trx
          .withSchema('app')
          .deleteFrom('favorites')
          .where('app_id', '=', appId)
          .where('user_id', '=', userId)
          .execute();
      });
    },
  };
}
