import { expect } from 'vitest';
import type { RootLogger } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  createTaobaoPriceSettings,
  type PriceAnomalyReason,
  type TaobaoPriceConfigReader,
  type TaobaoPriceInput,
  type TaobaoPriceOptions,
  type TaobaoPriceResult,
  type TaobaoPriceSettingsReader,
} from '../../../../apps/api/src/modules/union/index.ts';

// B1-22q rule tests. All data is synthetic domain fen values, never a platform response.
export const MEMBER = 'price.taobao.member_title_keywords';
export const COUPON = 'price.taobao.coupon_titles';
export const DISCOUNT = 'price.taobao.discount_titles';
export const UNKNOWN = 'price.taobao.unknown_promo';
export const BASIS = 'price.taobao.basis';
export const KEYS = [MEMBER, COUPON, DISCOUNT, UNKNOWN, BASIS] as const;
export type PriceKey = (typeof KEYS)[number];

/** 08 BR-PRICE-02 细则「淘宝优惠明细的分类」defaults, written out here (not imported). */
export const DEFAULTS: Readonly<Record<PriceKey, unknown>> = {
  [MEMBER]: ['88VIP'],
  [COUPON]: ['商品券', '店铺券'],
  [DISCOUNT]: ['百亿补贴', '秒杀直降', '限时补贴', '限时优惠', '满元减', '满件折'],
  [UNKNOWN]: 'unavailable',
  [BASIS]: 'promotion_path',
};

/** Valid values that differ from every default, so a fallback is visible. */
export const CUSTOM: Readonly<Record<PriceKey, unknown>> = {
  [MEMBER]: ['演示会员'],
  [COUPON]: ['演示券'],
  [DISCOUNT]: ['演示立减'],
  [UNKNOWN]: 'count',
  [BASIS]: 'coupon_only',
};

export const APP = 'synthetic-price-app';
export const OTHER_APP = 'synthetic-price-app-b';
export const now = 1_900_000_000_000;

/** The setting mapTaobaoPrice applies per key: an omitted option means the 08 default. */
export function effective(options: TaobaoPriceOptions): Record<PriceKey, unknown> {
  expect(options, 'read() resolves to an options object').toBeTypeOf('object');
  return {
    [MEMBER]: options.member_title_keywords ?? DEFAULTS[MEMBER],
    [COUPON]: options.coupon_titles ?? DEFAULTS[COUPON],
    [DISCOUNT]: options.discount_titles ?? DEFAULTS[DISCOUNT],
    [UNKNOWN]: options.unknown_promo ?? DEFAULTS[UNKNOWN],
    [BASIS]: options.basis ?? DEFAULTS[BASIS],
  };
}

export interface ConfigCall {
  readonly appId: string;
  readonly key: string;
}

/**
 * In-memory stand-in for content's ContentReader.configValue: a configured key answers
 * `{ value, version }`, anything else null. `answer` stores a raw answer (null, undefined, ...).
 */
export function fakeConfig() {
  const answers = new Map<string, unknown>();
  const calls: ConfigCall[] = [];
  const id = (appId: string, key: string) => JSON.stringify([appId, key]);
  const reader: TaobaoPriceConfigReader = {
    configValue(appId: string, key: string): Promise<unknown> {
      calls.push({ appId, key });
      const stored = id(appId, key);
      return Promise.resolve(answers.has(stored) ? answers.get(stored) : null);
    },
  };
  return {
    reader,
    calls,
    answer(key: string, raw: unknown, appId: string = APP): void {
      answers.set(id(appId, key), raw);
    },
    set(key: string, value: unknown, appId: string = APP): void {
      answers.set(id(appId, key), { value, version: 1 });
    },
    remove(key: string, appId: string = APP): void {
      answers.delete(id(appId, key));
    },
  };
}
export type FakeConfig = ReturnType<typeof fakeConfig>;

export function fakeLogger() {
  const warns: unknown[][] = [];
  const logger = {
    warn: (...args: unknown[]) => {
      warns.push(args);
    },
  } as unknown as Pick<RootLogger, 'warn'>;
  return { logger, warns };
}

/** The flat pino fields of one warn call (first argument). */
export function warnFields(args: readonly unknown[] | undefined): Record<string, unknown> {
  expect(args, 'a warn call').toBeDefined();
  const first = args![0];
  expect(first, 'warn is logged with pino fields first').toBeTypeOf('object');
  expect(first).not.toBeNull();
  return first as Record<string, unknown>;
}

/** One warn naming `key` with a non-empty event; returns the event. */
export function expectKeyWarn(args: readonly unknown[] | undefined, key: string): string {
  const fields = warnFields(args);
  expect(Object.values(fields)).toContain(key);
  expect(fields.event).toBeTypeOf('string');
  expect(fields.event).not.toBe('');
  return fields.event as string;
}

export function settings(
  config: FakeConfig,
  logger: Pick<RootLogger, 'warn'> = fakeLogger().logger,
): TaobaoPriceSettingsReader {
  return createTaobaoPriceSettings({ config: config.reader, logger });
}

/** One read of `values` for APP; returns the options and the warn calls. */
export async function readWith(
  values: Readonly<Record<string, unknown>>,
): Promise<{ options: TaobaoPriceOptions; warns: unknown[][] }> {
  const config = fakeConfig();
  for (const [key, value] of Object.entries(values)) config.set(key, value);
  const { logger, warns } = fakeLogger();
  const options = await settings(config, logger).read(APP);
  return { options, warns };
}

/** 08 例表 input: coupon 500, platform discount 1000, member 125 (3990 − 1625 = 2365). */
export const example: TaobaoPriceInput = {
  discount_fen: 3990n,
  promotion_final_fen: 2365n,
  promotions: [
    { title: '商品券', amount_fen: 500n, id: 'demo-coupon' },
    { title: '百亿补贴', amount_fen: 1000n },
    { title: '88VIP9.5折', amount_fen: 125n },
  ],
};

/** A coupon 300 and an unlisted name 200 (3990 − 500 = 3490). */
export const withUnknown: TaobaoPriceInput = {
  discount_fen: 3990n,
  promotion_final_fen: 3490n,
  promotions: [
    { title: '店铺券', amount_fen: 300n, id: 'demo-store' },
    { title: '某个清单外的名称', amount_fen: 200n },
  ],
};

export function expectPrice(
  result: TaobaoPriceResult,
  price: bigint,
  coupon: bigint,
  final: bigint,
  ids?: string,
): void {
  expect(result).toMatchObject({
    price_fen: price,
    coupon_fen: coupon,
    final_price_fen: final,
    price_status: 'ok',
  });
  if (ids === undefined) expect(Object.hasOwn(result, 'coupon_ids')).toBe(false);
  else expect(result.coupon_ids).toBe(ids);
}

export function expectAnomaly(result: TaobaoPriceResult, reason: PriceAnomalyReason): void {
  expect(result).toMatchObject({
    price_fen: 0n,
    coupon_fen: 0n,
    final_price_fen: 0n,
    price_status: 'anomaly',
    price_anomaly_reason: reason,
  });
}

/** JSON text of logged arguments (bigint as text), for "must not contain" checks. */
export function logged(calls: readonly (readonly unknown[])[]): string {
  return JSON.stringify(calls, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}
