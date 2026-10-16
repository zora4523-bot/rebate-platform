// B1-29a: the Kysely read side of the price trend (couli_app; schema app). Reads only
// app.platforms.key_stability and app.price_snapshot; never writes.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { PlatformRecord } from '../domain/types.ts';
import type { PriceSnapshotSourceKind } from '../price-history/types.ts';
import type { PriceTrendStore } from './types.ts';

/**
 * keyStability: platforms.key_stability by code (null when no row).
 * rows: price_snapshot rows WHERE app_id, platform and product_key equal the query and the run
 * [first_observed_at, last_observed_at] meets [from, until), all source kinds; no filter on
 * first_observed_at >= from (a run crossing the window start must be returned).
 */
export function createKyselyPriceTrendStore(db: Kysely<DB>): PriceTrendStore {
  const table = db.withSchema('app');
  return {
    async keyStability(platform) {
      const row = await table
        .selectFrom('platforms')
        .select('key_stability')
        .where('code', '=', platform)
        .executeTakeFirst();
      // The CHECK constraint restricts the generated string type to these four values.
      return (row?.key_stability as PlatformRecord['key_stability'] | undefined) ?? null;
    },
    async rows(query) {
      const rows = await table
        .selectFrom('price_snapshot')
        .select([
          'source_kind',
          'coupon_fen',
          'final_price_fen',
          'first_observed_at',
          'last_observed_at',
        ])
        .where('app_id', '=', query.appId)
        .where('platform', '=', query.platform)
        .where('product_key', '=', query.productKey)
        .where('first_observed_at', '<', query.until)
        .where('last_observed_at', '>=', query.from)
        .execute();
      return rows.map((row) => ({
        // source_kind is likewise restricted by the price_snapshot CHECK constraint.
        sourceKind: row.source_kind as PriceSnapshotSourceKind,
        couponFen: row.coupon_fen,
        finalPriceFen: row.final_price_fen,
        firstObservedAt: row.first_observed_at,
        lastObservedAt: row.last_observed_at,
      }));
    },
  };
}
