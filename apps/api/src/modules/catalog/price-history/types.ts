// B1-17b: shared types of the price change history writer (BR-WATCH-05 (2) price_snapshot,
// BR-WATCH-19 (1)). Leaf file: no imports from catalog/index.ts. Rule tests:
// test/spec/catalog/price-history/**.
import type { Logger } from 'pino';
import type { Clock } from '../../platform/index.ts';
import type { Platform } from '../../union/index.ts';
import type { CatalogConfigReader } from '../ports.ts';

/** app.price_snapshot.source_kind, the closed set of BR-WATCH-05. */
export type PriceSnapshotSourceKind = 'search' | 'detail' | 'quote' | 'convert' | 'watch';

/** The run key: rows are only ever compared inside one (app_id, product_key, source_kind). */
export interface PriceSnapshotKey {
  readonly appId: string;
  readonly productKey: string;
  readonly sourceKind: PriceSnapshotSourceKind;
}

/** The four values a run is made of (BR-WATCH-05: a change in any of them starts a new row). */
export interface PriceSnapshotValues {
  readonly priceFen: bigint;
  readonly couponFen: bigint;
  readonly finalPriceFen: bigint;
  readonly inStock: boolean;
}

/** The latest row of a key as the run decision needs it. */
export interface PriceSnapshotRun extends PriceSnapshotValues {
  readonly firstObservedAt: Date;
  readonly lastObservedAt: Date;
  readonly observationCount: number;
}

/** One union price reading at one instant, as the run decision needs it. */
export interface PriceRunObservation {
  readonly values: PriceSnapshotValues;
  readonly observedAt: Date;
}

/**
 * What to do with one observation:
 *   insert  a new row with first_observed_at = last_observed_at = observedAt, count 1;
 *   touch   UPDATE the latest row: last_observed_at = lastObservedAt (= observedAt),
 *           observation_count = observationCount (= latest count + 1);
 *   none    change nothing.
 */
export type PriceRunDecision =
  | { readonly kind: 'insert' }
  | {
      readonly kind: 'touch';
      readonly lastObservedAt: Date;
      readonly observationCount: number;
    }
  | { readonly kind: 'none' };

/** How the union call that produced the observation ended. Only 'ok' may be written. */
export type PriceObservationOutcome = 'ok' | 'failed' | 'timeout' | 'rate_limited';

/**
 * One union return handed to the recorder after the response. By construction it carries no user
 * identifier of any kind (BR-WATCH-19: no user_id, device_id, relation_id, subUnionId,
 * custom_parameters, promotion slot, cPin / xid_buyer, region, device fingerprint); whether the
 * call itself used such a user-level parameter is only the flag userScoped.
 */
export interface PriceObservation {
  readonly appId: string;
  readonly platform: Platform;
  readonly productKey: string;
  readonly skuKey: string | null;
  readonly sourceKind: PriceSnapshotSourceKind;
  readonly outcome: PriceObservationOutcome;
  readonly priceFen: bigint;
  readonly couponFen: bigint;
  readonly finalPriceFen: bigint;
  /** The union item's price_status (BR-PRICE-01); 'anomaly' is never written. */
  readonly priceStatus: 'ok' | 'anomaly';
  readonly inStock: boolean;
  /** true only for a fresh union return; a cache hit or a stale entry is false. */
  readonly fresh: boolean;
  /** true when the union call carried any user-level parameter (BR-WATCH-19 list). */
  readonly userScoped: boolean;
  /** PDD: the goods_sign plan (search / detail general plan) of the price; null when unknown. */
  readonly goodsSignPlan: string | null;
}

/**
 * Why an observation is not written (first matching reason in this order):
 *   upstream_failed   outcome is not 'ok' (failure, timeout, rate limit; BR-WATCH-05);
 *   price_anomaly     union's isPriceAnomaly (BR-PRICE-01);
 *   not_fresh         cache hit or stale result;
 *   user_scoped       the return was fetched with a user-level parameter (BR-WATCH-19);
 *   convert           source_kind convert (BR-WATCH-19 example: not proven independent of
 *                     relation_id, so never written);
 *   pdd_without_plan  platform pdd without a goods_sign_plan (orchestrator ruling 6).
 */
export type PriceSnapshotSkipReason =
  | 'upstream_failed'
  | 'price_anomaly'
  | 'not_fresh'
  | 'user_scoped'
  | 'convert'
  | 'pdd_without_plan';

/** One write the store performs in one transaction. Only table columns, no user identifier. */
export interface PriceSnapshotWrite {
  readonly appId: string;
  readonly platform: Platform;
  readonly productKey: string;
  readonly skuKey: string | null;
  readonly sourceKind: PriceSnapshotSourceKind;
  readonly values: PriceSnapshotValues;
  /** Written to goods_sign_plan as is (the PDD plan; null for the other platforms). */
  readonly goodsSignPlan: string | null;
  /** From the injected Clock, never SQL now(). */
  readonly observedAt: Date;
  /** price_snapshot.touch_min_interval_minutes, already normalised (positive integer). */
  readonly touchMinIntervalMinutes: number;
}

/** What the store did: inserted a new run, touched the latest row, or changed nothing. */
export type PriceSnapshotWriteOutcome = 'inserted' | 'touched' | 'unchanged';

/** The single writer of app.price_snapshot. */
export interface PriceSnapshotStore {
  /**
   * One transaction: pg_advisory_xact_lock(priceSnapshotLockKey(appId, productKey, sourceKind))
   * (the bigint form), then read the latest row of the key (first_observed_at DESC, id DESC),
   * decidePriceRun, then INSERT or an UPDATE of last_observed_at and observation_count only.
   * Rejects on a database error; no retry.
   */
  write(input: PriceSnapshotWrite): Promise<PriceSnapshotWriteOutcome>;
}

export interface PriceSnapshotRecorderOptions {
  readonly store: PriceSnapshotStore;
  readonly clock: Clock;
  /** price_snapshot.touch_min_interval_minutes is read through it, per app. */
  readonly config: CatalogConfigReader;
  /** One flat warn with code PRICE_SNAPSHOT_WRITE_FAILED per failed write. */
  readonly logger: Pick<Logger, 'warn'>;
}

/** The after-response hook of BR-WATCH-19 (1). */
export interface PriceSnapshotRecorder {
  /**
   * Hand off and return at once (returns nothing, never a promise, never throws, whatever the
   * input, the store, the config reader or the Clock do). The observation time is read from the
   * Clock synchronously inside this call. A skipped observation (priceSnapshotSkipReason) never
   * reaches the store. The rest runs in the background: read the interval (default 10 when
   * missing, not a positive safe integer or the read fails), then exactly one store.write. A
   * failure is never retried: failureCount() + 1 and one flat logger.warn with
   * code 'PRICE_SNAPSHOT_WRITE_FAILED'.
   */
  record(observation: PriceObservation): void;
  /** Resolves once every write handed off so far has settled; never rejects. */
  drain(): Promise<void>;
  /** Failed writes since creation (a skipped observation is not a failure). */
  failureCount(): number;
}
