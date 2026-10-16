// B1-29a: the Kysely read side of the price trend (couli_app; schema app). Reads only
// app.platforms.key_stability and app.price_snapshot; never writes.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { PriceTrendStore } from './types.ts';

/**
 * keyStability: platforms.key_stability by code (null when no row).
 * rows: price_snapshot rows WHERE app_id, platform and product_key equal the query and the run
 * [first_observed_at, last_observed_at] meets [from, until), all source kinds; no filter on
 * first_observed_at >= from (a run crossing the window start must be returned).
 */
export function createKyselyPriceTrendStore(db: Kysely<DB>): PriceTrendStore {
  void db;
  throw new Error('NotImplemented: createKyselyPriceTrendStore');
}
