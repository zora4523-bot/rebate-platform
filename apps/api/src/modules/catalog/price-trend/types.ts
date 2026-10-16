// B1-29a: types of the price trend read (GET /v1/products/{product_key}/price-trend, CT-22a;
// BR-WATCH-05 (2) price_snapshot runs, BR-PROD-03 key_stability, BR-TEXT-11 plain dates).
// Leaf file: no imports from catalog/index.ts. Rule tests: test/spec/catalog/price-trend/**.
import type { Clock } from '../../platform/index.ts';
import type { PlatformRecord } from '../domain/types.ts';
import type { CatalogConfigReader } from '../ports.ts';
import type { PriceSnapshotSourceKind } from '../price-history/types.ts';

export type PriceTrendStatus = 'ok' | 'no_data';

/** price_trend.source when the last point's row carries a coupon, else .general (BR-PRICE-04). */
export type PriceTrendSourceKey = 'price_trend.source' | 'price_trend.source.general';

/** One natural day in +08:00 (date YYYY-MM-DD) and the final price chosen for it. */
export interface PriceTrendPoint {
  readonly date: string;
  readonly final_price_fen: bigint;
}

/**
 * The data of the price trend response (contract ProductPriceTrend). Nothing else: no user,
 * device or request identifier of any kind.
 *   ok       points in ascending date order, start_date = date of the first point;
 *   no_data  points [], start_date null, source_key 'price_trend.source.general'.
 */
export interface PriceTrend {
  readonly status: PriceTrendStatus;
  readonly points: readonly PriceTrendPoint[];
  readonly start_date: string | null;
  readonly window_days: 30;
  readonly source_key: PriceTrendSourceKey;
}

/** One price_snapshot run as the trend needs it (a run: same price from first to last). */
export interface PriceTrendRow {
  readonly sourceKind: PriceSnapshotSourceKind;
  readonly couponFen: bigint;
  readonly finalPriceFen: bigint;
  readonly firstObservedAt: Date;
  readonly lastObservedAt: Date;
}

/** What the caller asks for; app_id is server-injected scope, never a user identifier. */
export interface PriceTrendQuery {
  readonly appId: string;
  readonly platform: string;
  readonly productKey: string;
}

/** The rows read: runs of (appId, platform, productKey) whose [first, last] meets [from, until). */
export interface PriceTrendRowsQuery extends PriceTrendQuery {
  readonly from: Date;
  readonly until: Date;
}

/** Read-only access to app.platforms and app.price_snapshot. */
export interface PriceTrendStore {
  /** platforms.key_stability of the platform code; null when the platform is unknown. */
  keyStability(platform: string): Promise<PlatformRecord['key_stability'] | null>;
  /**
   * The runs of exactly (appId, platform, productKey), every source_kind, including runs that
   * started before `from` (a run crossing the window start counts inside the window).
   */
  rows(query: PriceTrendRowsQuery): Promise<readonly PriceTrendRow[]>;
}

export interface PriceTrendOptions {
  readonly store: PriceTrendStore;
  /** Today (+08:00) is read from it once per call. */
  readonly clock: Clock;
  /** price_trend.min_distinct_days is read through it, per app (default 2). */
  readonly config: CatalogConfigReader;
}
