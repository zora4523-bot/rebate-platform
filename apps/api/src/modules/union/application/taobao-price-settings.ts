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
  const { config, logger } = options;
  return {
    async read(appId: string): Promise<TaobaoPriceOptions> {
      return (await readTaobaoPriceSettings(config, logger, appId)).options;
    },
  };
}

/** The fixed warn event of an invalid price.taobao.* value; the fields are this and the key. */
const TAOBAO_PRICE_CONFIG_INVALID = 'TAOBAO_PRICE_CONFIG_INVALID';

const MEMBER_KEY = 'price.taobao.member_title_keywords';
const COUPON_KEY = 'price.taobao.coupon_titles';
const DISCOUNT_KEY = 'price.taobao.discount_titles';
const UNKNOWN_KEY = 'price.taobao.unknown_promo';
const BASIS_KEY = 'price.taobao.basis';

const UNKNOWN_PROMO_VALUES = ['unavailable', 'add_back', 'count'] as const;
const BASIS_VALUES = ['promotion_path', 'coupon_only'] as const;

/** A missing key (null / undefined answer or value) applies the 08 default without a warning. */
const MISSING = Symbol('missing');
/** A present value that is not acceptable: the 08 default applies and the key is warned once. */
const INVALID = Symbol('invalid');

/** The stored value of a ContentReader.configValue answer (`{ value, version }` or null). */
function storedValue(answer: unknown): unknown {
  if (answer === null || answer === undefined) return MISSING;
  if (typeof answer !== 'object' || !Object.hasOwn(answer, 'value')) return INVALID;
  const value: unknown = (answer as { readonly value: unknown }).value;
  return value === null || value === undefined ? MISSING : value;
}

/** A non-empty array of strings, none blank after NFKC + trim (the mapping's normalization). */
function titleList(value: unknown): readonly string[] | typeof INVALID {
  if (!Array.isArray(value) || value.length === 0) return INVALID;
  const list: string[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== 'string' || entry.normalize('NFKC').trim() === '') return INVALID;
    list.push(entry);
  }
  return Object.freeze(list);
}

function oneOf<T extends string>(allowed: readonly T[]) {
  return (value: unknown): T | typeof INVALID =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : INVALID;
}

/**
 * One read of the five keys of `appId` (all read on every call, no cache). The keys are read
 * concurrently; each is checked on its own, so one invalid key never affects another.
 */
async function readTaobaoPriceSettings(
  config: TaobaoPriceConfigReader,
  logger: Pick<RootLogger, 'warn'>,
  appId: string,
): Promise<TaobaoPriceSettings> {
  const invalidKeys: string[] = [];
  const setting = async <T>(
    key: string,
    parse: (value: unknown) => T | typeof INVALID,
  ): Promise<T | undefined> => {
    const value = storedValue(await config.configValue(appId, key));
    if (value === MISSING) return undefined;
    const parsed = value === INVALID ? INVALID : parse(value);
    if (parsed !== INVALID) return parsed;
    invalidKeys.push(key);
    // Only the fixed event and the key name: no stored value, item data or credentials.
    logger.warn(
      { event: TAOBAO_PRICE_CONFIG_INVALID, key },
      'invalid taobao price configuration; the default applies',
    );
    return undefined;
  };
  const [member, coupon, discount, unknown, basis] = await Promise.all([
    setting(MEMBER_KEY, titleList),
    setting(COUPON_KEY, titleList),
    setting(DISCOUNT_KEY, titleList),
    setting(UNKNOWN_KEY, oneOf(UNKNOWN_PROMO_VALUES)),
    setting(BASIS_KEY, oneOf(BASIS_VALUES)),
  ]);
  // An omitted option is the 08 default inside mapTaobaoPrice (TAOBAO_PRICE_DEFAULTS).
  const options: TaobaoPriceOptions = Object.freeze({
    ...(member === undefined ? {} : { member_title_keywords: member }),
    ...(coupon === undefined ? {} : { coupon_titles: coupon }),
    ...(discount === undefined ? {} : { discount_titles: discount }),
    ...(unknown === undefined ? {} : { unknown_promo: unknown }),
    ...(basis === undefined ? {} : { basis }),
  });
  return { options, invalidKeys: Object.freeze(invalidKeys) };
}
