// B1-22q: the BR-PRICE-02 Taobao price lists and switches as server configuration (price.taobao.*).
// union does not depend on content (规划/02 §4.1): it defines this read port, and app.module passes
// content's ContentReader to it.
import type { RootLogger } from '../../platform/index.ts';
import type { TaobaoPriceOptions, TaobaoPriceSettingsReader } from '../domain/taobao-price.ts';

/**
 * The configuration read port, the same shape as Pick<ContentReader, 'configValue'>: it answers
 * the stored item (`{ value, version }`) or null when the key is not configured.
 */
export type TaobaoPriceConfigReader = {
  configValue(appId: string, key: string): Promise<unknown>;
};

/** One read of the five keys: the options to map with, and the keys that fell back as invalid. */
export interface TaobaoPriceSettings {
  readonly options: TaobaoPriceOptions;
  readonly invalidKeys: readonly string[];
}

export interface TaobaoPriceSettingsOptions {
  readonly config: TaobaoPriceConfigReader;
  readonly logger: Pick<RootLogger, 'warn'>;
}

/**
 * Every read() reads price.taobao.member_title_keywords / coupon_titles / discount_titles /
 * unknown_promo / basis of the app (no cache). A missing value (null / undefined) uses the 08
 * default without a warning; an invalid value falls back to the 08 default for that key only and
 * warns once with a fixed event and the key name (no item data, no credentials). Arrays replace
 * the defaults; they are not merged with them.
 */
export function createTaobaoPriceSettings(
  options: TaobaoPriceSettingsOptions,
): TaobaoPriceSettingsReader {
  void options;
  throw new Error('NotImplemented: createTaobaoPriceSettings');
}
