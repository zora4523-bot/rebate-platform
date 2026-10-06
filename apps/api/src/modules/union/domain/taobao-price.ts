export type PriceAnomalyReason =
  'missing_field' | 'calc_diff' | 'expired_item' | 'unknown_promo' | 'invalid_price';

/** Domain amounts are integer fen, not upstream yuan strings or platform payloads.
 * Unknown permits missing/invalid values to fail closed at this boundary.
 * Upstream yuan parsing belongs to the adapter's @couli/domain.parseYuanToFen boundary.
 */
export interface TaobaoPromotion {
  readonly title: string;
  readonly amount_fen?: unknown;
  readonly id?: string;
  /** Optional epoch milliseconds; no time-zone or date-only strings at this boundary. */
  readonly start_ms?: unknown;
  readonly end_ms?: unknown;
}

export interface TaobaoPriceInput {
  readonly discount_fen?: unknown;
  readonly promotion_final_fen?: unknown;
  readonly promotions?: readonly TaobaoPromotion[];
}

/** Omitted settings use BR-PRICE-02 defaults; explicit arrays replace those defaults.
 * TODO(规划/11 §9.2): 配置端口接入 app.module — blocked on followups F-36
 */
export interface TaobaoPriceOptions {
  readonly member_title_keywords?: readonly string[];
  readonly coupon_titles?: readonly string[];
  readonly discount_titles?: readonly string[];
  readonly unknown_promo?: 'unavailable' | 'add_back' | 'count';
  readonly basis?: 'promotion_path' | 'coupon_only';
}

/** Pure function returns flat warning events for the adapter to log through pino. */
export type TaobaoPriceWarning =
  | { readonly code: 'PRICE_CALC_DIFF' }
  | { readonly code: 'PRICE_PROMO_UNKNOWN'; readonly title: string };

export interface TaobaoPriceResult {
  readonly price_fen: bigint;
  readonly coupon_fen: bigint;
  readonly final_price_fen: bigint;
  readonly coupon_ids?: string;
  readonly price_status: 'ok' | 'anomaly';
  readonly price_anomaly_reason?: PriceAnomalyReason;
  readonly warnings: readonly TaobaoPriceWarning[];
}

/** now is the injected fetch time in epoch milliseconds; this function performs no I/O. */
export function mapTaobaoPrice(
  input: TaobaoPriceInput,
  now: number,
  options?: TaobaoPriceOptions,
): TaobaoPriceResult {
  void input;
  void now;
  void options;
  throw new Error('NotImplemented: mapTaobaoPrice');
}

export function isPriceAnomaly(item: {
  readonly price_fen: bigint;
  readonly coupon_fen: bigint;
  readonly final_price_fen: bigint;
  readonly price_status?: 'ok' | 'anomaly';
}): boolean {
  void item;
  throw new Error('NotImplemented: isPriceAnomaly');
}
