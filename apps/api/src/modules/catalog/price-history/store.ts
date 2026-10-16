// B1-17b: the Kysely store of app.price_snapshot (BR-WATCH-05 (2): transaction-level advisory
// lock on the key, then read the latest row, compare, insert or update).
import { createHash } from 'node:crypto';
import type { DB } from '@couli/db';
import { sql, type Kysely } from 'kysely';
import { decidePriceRun } from './run.ts';
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
  // JSON's escaping preserves tuple boundaries, including separators inside a component.
  const encoded = JSON.stringify(['catalog.price_snapshot', appId, productKey, sourceKind]);
  return createHash('sha256').update(encoded, 'utf8').digest().readBigInt64BE(0);
}

/**
 * The store on a couli_app connection (schema app). Each write is its own transaction:
 * pg_advisory_xact_lock(priceSnapshotLockKey(…)), the latest row by first_observed_at DESC, id
 * DESC, decidePriceRun, then INSERT (first = last = observedAt, count 1) or UPDATE of
 * last_observed_at and observation_count only. Times come from input.observedAt, never SQL now().
 */
export function createKyselyPriceSnapshotStore(db: Kysely<DB>): PriceSnapshotStore {
  return {
    async write(input) {
      // Each statement must see commits made while we were waiting for the advisory lock.
      return db
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (trx) => {
          const lockKey = priceSnapshotLockKey(input.appId, input.productKey, input.sourceKind);
          await sql`SELECT pg_advisory_xact_lock(${lockKey.toString()}::bigint)`.execute(trx);
          const table = trx.withSchema('app');
          const latest = await table
            .selectFrom('price_snapshot')
            .select([
              'id',
              'price_fen',
              'coupon_fen',
              'final_price_fen',
              'in_stock',
              'first_observed_at',
              'last_observed_at',
              'observation_count',
            ])
            .where('app_id', '=', input.appId)
            .where('product_key', '=', input.productKey)
            .where('source_kind', '=', input.sourceKind)
            .orderBy('first_observed_at', 'desc')
            .orderBy('id', 'desc')
            .limit(1)
            .executeTakeFirst();
          const decision = decidePriceRun(
            latest === undefined
              ? null
              : {
                  priceFen: latest.price_fen,
                  couponFen: latest.coupon_fen,
                  finalPriceFen: latest.final_price_fen,
                  inStock: latest.in_stock,
                  firstObservedAt: latest.first_observed_at,
                  lastObservedAt: latest.last_observed_at,
                  observationCount: latest.observation_count,
                },
            input,
            input.touchMinIntervalMinutes,
          );
          if (decision.kind === 'insert') {
            await table
              .insertInto('price_snapshot')
              .values({
                app_id: input.appId,
                platform: input.platform,
                product_key: input.productKey,
                sku_key: input.skuKey,
                source_kind: input.sourceKind,
                price_fen: input.values.priceFen,
                coupon_fen: input.values.couponFen,
                final_price_fen: input.values.finalPriceFen,
                in_stock: input.values.inStock,
                goods_sign_plan: input.goodsSignPlan,
                first_observed_at: input.observedAt,
                last_observed_at: input.observedAt,
                observation_count: 1,
                created_at: input.observedAt,
              })
              .execute();
            return 'inserted';
          }
          if (decision.kind === 'touch' && latest !== undefined) {
            await table
              .updateTable('price_snapshot')
              .set({
                last_observed_at: decision.lastObservedAt,
                observation_count: decision.observationCount,
              })
              .where('app_id', '=', input.appId)
              .where('product_key', '=', input.productKey)
              .where('source_kind', '=', input.sourceKind)
              .where('id', '=', latest.id)
              .where('first_observed_at', '=', latest.first_observed_at)
              .execute();
            return 'touched';
          }
          return 'unchanged';
        });
    },
  };
}
