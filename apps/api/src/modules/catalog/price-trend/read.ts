// B1-29a: the read use case of the price trend (no route here; B1-29b registers it).
import type { PriceTrend, PriceTrendOptions, PriceTrendQuery } from './types.ts';

/**
 * Orchestrator rulings B.5, B.6, B.9, B.11:
 *   1. store.keyStability(query.platform) is not 'stable_7d' (or null) → no_data; reading the
 *      rows is then optional.
 *   2. price_trend.min_distinct_days through options.config.configValue(appId, key); default 2
 *      when missing, not a positive safe integer, or the read fails.
 *   3. store.rows for exactly (appId, platform, productKey) and the window of options.clock.now(),
 *      then computePriceTrend. Only price_snapshot is read: no observation table, no union call.
 * The result has only the PriceTrend fields; nothing from the caller beyond the query is used.
 */
export function getPriceTrend(
  options: PriceTrendOptions,
  query: PriceTrendQuery,
): Promise<PriceTrend> {
  void options;
  void query;
  throw new Error('NotImplemented: getPriceTrend');
}
