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

// B1-22w rule tests (D10-446 ②): a configValue that throws (store error, deadline …) no longer
// fails the Taobao mapping; that key uses the 08 default for that read and warns once.
// All data is synthetic; nothing here is a platform response, a real credential or a real error.
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

export const APP = 'synthetic-fallback-app';
export const OTHER_APP = 'synthetic-fallback-app-b';
export const now = 1_900_000_000_000;

/** Markers inside the synthetic error text: none of them may reach a log line. */
export const DETAIL_MARKER = 'Q7xv-store-detail';
export const CREDENTIAL_MARKER = 'Lm42-synthetic-credential';
const ERROR_TEXT = `synthetic config store unavailable ${DETAIL_MARKER} secret=${CREDENTIAL_MARKER}`;

/** A synthetic store failure; its class name and `name` are the same. */
export class SyntheticStoreError extends Error {
  override name = 'SyntheticStoreError';
}

/** A synthetic deadline failure (the reader gave up waiting); class name and `name` agree. */
export class SyntheticDeadlineError extends Error {
  override name = 'SyntheticDeadlineError';
}

export type ErrorKind = 'SyntheticStoreError' | 'SyntheticDeadlineError';

export function syntheticError(kind: ErrorKind): Error {
  return kind === 'SyntheticStoreError'
    ? new SyntheticStoreError(ERROR_TEXT)
    : new SyntheticDeadlineError(ERROR_TEXT);
}

/** How configValue fails: a rejected promise, or a synchronous throw. */
export type FailMode = 'reject' | 'throw';

export interface ConfigCall {
  readonly appId: string;
  readonly key: string;
}

/**
 * In-memory stand-in for content's ContentReader.configValue: a configured key answers
 * `{ value, version }`, anything else null; a failed key rejects (or throws) with its error.
 */
export function failingConfig() {
  const answers = new Map<string, unknown>();
  const failures = new Map<string, { readonly mode: FailMode; readonly error: unknown }>();
  const calls: ConfigCall[] = [];
  const id = (appId: string, key: string) => JSON.stringify([appId, key]);
  const reader: TaobaoPriceConfigReader = {
    configValue(appId: string, key: string): Promise<unknown> {
      calls.push({ appId, key });
      const failure = failures.get(id(appId, key));
      if (failure !== undefined) {
        if (failure.mode === 'throw') throw failure.error;
        return Promise.reject(failure.error);
      }
      const stored = id(appId, key);
      return Promise.resolve(answers.has(stored) ? answers.get(stored) : null);
    },
  };
  return {
    reader,
    calls,
    set(key: string, value: unknown, appId: string = APP): void {
      answers.set(id(appId, key), { value, version: 1 });
    },
    setAll(values: Readonly<Record<string, unknown>>, appId: string = APP): void {
      for (const [key, value] of Object.entries(values)) {
        answers.set(id(appId, key), { value, version: 1 });
      }
    },
    fail(key: string, error: unknown, mode: FailMode = 'reject', appId: string = APP): void {
      failures.set(id(appId, key), { mode, error });
    },
    failAll(error: unknown, mode: FailMode = 'reject', appId: string = APP): void {
      for (const key of KEYS) failures.set(id(appId, key), { mode, error });
    },
    heal(key: string, appId: string = APP): void {
      failures.delete(id(appId, key));
    },
    healAll(appId: string = APP): void {
      for (const key of KEYS) failures.delete(id(appId, key));
    },
  };
}
export type FailingConfig = ReturnType<typeof failingConfig>;

export function fakeLogger() {
  const warns: unknown[][] = [];
  const logger = {
    warn: (...args: unknown[]) => {
      warns.push(args);
    },
  } as unknown as Pick<RootLogger, 'warn'>;
  return { logger, warns };
}

export function settings(
  config: FailingConfig,
  logger: Pick<RootLogger, 'warn'> = fakeLogger().logger,
): TaobaoPriceSettingsReader {
  return createTaobaoPriceSettings({ config: config.reader, logger });
}

/**
 * The value of a promise that must resolve. A rejection becomes one assertion failure (never the
 * rejected error itself), so the failing read shows as "did not resolve".
 */
export async function settle<T>(promise: Promise<T>, what: string): Promise<T> {
  let resolved = false;
  let value: T | undefined;
  try {
    value = await promise;
    resolved = true;
  } catch {
    resolved = false;
  }
  expect(resolved, `${what} resolves although the configuration read failed`).toBe(true);
  return value as T;
}

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

/** The flat pino fields of one warn call (first argument). */
export function warnFields(args: readonly unknown[] | undefined): Record<string, unknown> {
  expect(args, 'a warn call').toBeDefined();
  const first = args![0];
  expect(first, 'warn is logged with pino fields first').toBeTypeOf('object');
  expect(first).not.toBeNull();
  return first as Record<string, unknown>;
}

/** The non-empty event of one warn call that names `key`. */
export function keyWarnEvent(args: readonly unknown[] | undefined, key: string): string {
  const fields = warnFields(args);
  expect(Object.values(fields)).toContain(key);
  expect(fields.event).toBeTypeOf('string');
  expect(fields.event).not.toBe('');
  return fields.event as string;
}

/** One read-failure warn: names `key` and, when given, the error class name; returns the event. */
export function readFailedEvent(
  args: readonly unknown[] | undefined,
  key: string,
  kind?: ErrorKind,
): string {
  const event = keyWarnEvent(args, key);
  if (kind !== undefined) expect(Object.values(warnFields(args))).toContain(kind);
  return event;
}

/** The warn call (of `warns`) whose fields name `key`; exactly one must. */
export function warnNaming(warns: readonly unknown[][], key: string): unknown[] {
  const named = warns.filter((call) => Object.values(warnFields(call)).includes(key));
  expect(named, `one warn names ${key}`).toHaveLength(1);
  return named[0]!;
}

/** The event B1-22q logs for an invalid value (TAOBAO_PRICE_CONFIG_INVALID), read off a real read. */
export async function invalidValueEvent(): Promise<string> {
  const config = failingConfig();
  config.set(BASIS, 'NOT_A_BASIS');
  const { logger, warns } = fakeLogger();
  await settings(config, logger).read(APP);
  expect(warns).toHaveLength(1);
  return keyWarnEvent(warns[0], BASIS);
}

/**
 * All text reachable from logged arguments: strings, numbers, property names, and of any Error
 * also its name, message, stack and cause (JSON.stringify would hide those).
 */
export function loggedText(calls: readonly (readonly unknown[])[]): string {
  const seen = new WeakSet<object>();
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
      parts.push(String(value));
      return;
    }
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Error) {
      parts.push(value.name, value.message, value.stack ?? '');
      walk(value.cause);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'string') parts.push(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && 'value' in descriptor) walk(descriptor.value);
    }
  };
  for (const call of calls) walk(call);
  return parts.join('\n');
}

/** How many Error objects are reachable from logged arguments (the error itself is never logged). */
export function errorsLogged(calls: readonly (readonly unknown[])[]): number {
  const seen = new WeakSet<object>();
  let count = 0;
  const walk = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Error) count++;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && 'value' in descriptor) walk(descriptor.value);
    }
  };
  for (const call of calls) walk(call);
  return count;
}

/** No error text, credential marker, stack or Error object in the logged arguments. */
export function expectNoErrorDetail(calls: readonly (readonly unknown[])[]): void {
  const text = loggedText(calls);
  expect(text).not.toContain(DETAIL_MARKER);
  expect(text).not.toContain(CREDENTIAL_MARKER);
  expect(text).not.toContain(ERROR_TEXT);
  expect(text).not.toMatch(/\n\s+at /);
  expect(errorsLogged(calls)).toBe(0);
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
): void {
  expect(result).toMatchObject({
    price_fen: price,
    coupon_fen: coupon,
    final_price_fen: final,
    price_status: 'ok',
  });
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
