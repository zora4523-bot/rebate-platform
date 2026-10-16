// B1-17b: the Kysely store of app.price_snapshot (BR-WATCH-05 (2): transaction-level advisory
// lock on the key, then read the latest row, compare, insert or update).
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import type { PriceSnapshotSourceKind, PriceSnapshotStore } from './types.ts';

/**
 * The bigint argument of pg_advisory_xact_lock(bigint) for one (app_id, product_key,
 * source_kind): deterministic, inside the signed 64-bit range, and different whenever any of the
 * three differs (no ambiguity from joining the parts, e.g. ('a:b', 'c') vs ('a', 'b:c')).
 */
export function priceSnapshotLockKey(
  appId: string,
  productKey: string,
  sourceKind: PriceSnapshotSourceKind,
): bigint {
  void appId;
  void productKey;
  void sourceKind;
  throw new Error('NotImplemented: priceSnapshotLockKey');
}

/**
 * The store on a couli_app connection (schema app). Each write is its own transaction:
 * pg_advisory_xact_lock(priceSnapshotLockKey(…)), the latest row by first_observed_at DESC, id
 * DESC, decidePriceRun, then INSERT (first = last = observedAt, count 1) or UPDATE of
 * last_observed_at and observation_count only. Times come from input.observedAt, never SQL now().
 */
export function createKyselyPriceSnapshotStore(db: Kysely<DB>): PriceSnapshotStore {
  void db;
  throw new Error('NotImplemented: createKyselyPriceSnapshotStore');
}
