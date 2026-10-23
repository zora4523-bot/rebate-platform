import { createRequire } from 'node:module';
import { expect, vi } from 'vitest';
import type { Clock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConnectionConfig } from '../../../../apps/api/src/modules/platform/db/index.ts';
import type { RequestCheckInput } from '../../../../apps/api/src/modules/platform/http/request-checks.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/index.ts';
import {
  RedisUnavailableError,
  type RedisHandle,
  type RedisNamespace,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { NONCE_TTL_SECONDS } from '../../../../apps/api/src/modules/risk/domain/request-signature.ts';
import { DEVICE, SMS, input, sign } from '../signature/kit.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));

/** 9.2 #4: the worker renews every 60 s; the key's TTL is 30 renewal intervals. */
export const RENEW_INTERVAL_MS = 60_000;
export const GENERATION_TTL_MS = 30 * RENEW_INTERVAL_MS;
/** 9.2 #1: refusal period = creation instant + NONCE_TTL_SECONDS (BR-ID-09). */
export const REFUSAL_MS = NONCE_TTL_SECONDS * 1000;

/** 32 lower-case hex characters, distinct per n. */
export function nonce(n: number): string {
  return n.toString(16).padStart(32, '0');
}

/** A correctly signed request of DEVICE, timestamped with `clock`'s current second. */
export function signed(clock: Clock, nonceValue: string): RequestCheckInput {
  const timestamp = String(Math.floor(clock.now().getTime() / 1000));
  const base = input();
  return {
    ...base,
    headers: {
      ...base.headers,
      'x-device-id': DEVICE,
      'x-timestamp': timestamp,
      'x-nonce': nonceValue,
      'x-sign': sign('POST', SMS, base.rawBody, timestamp, nonceValue),
    },
  };
}

/** The same request sent again (same headers and body, nothing verified yet): a replay. */
export function replay(request: RequestCheckInput): RequestCheckInput {
  return {
    id: request.id,
    method: request.method,
    url: request.url,
    ...(request.routeTemplate === undefined ? {} : { routeTemplate: request.routeTemplate }),
    headers: { ...request.headers },
    rawBody: request.rawBody,
  };
}

export function memoryLogger() {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, records, warns: () => records().filter((line) => line['level'] === 40) };
}

export function silentLogger() {
  return createRootLogger({ level: 'silent', entry: 'api', appEnv: 'test' });
}

/** The generation key's value as an instant: decimal epoch milliseconds or an ISO-8601 text. */
export function instantOf(value: unknown): number {
  expect(typeof value, 'the generation value is a string').toBe('string');
  const text = value as string;
  const ms = /^[0-9]+$/.test(text) ? Number(text) : Date.parse(text);
  expect(Number.isFinite(ms), 'the generation value is the creation instant').toBe(true);
  return ms;
}

/**
 * Memory Redis whose commands fail (RedisUnavailableError) as soon as one of their keys matches
 * `failing`; other evals behave as the nonce reservation (SET NX: 'OK', then null). Only the nonce
 * keys work when `failing` is notNonce: the generation key's store is down, the nonce store is up.
 */
export function splitRedis(failing: (key: string) => boolean) {
  const reserved = new Set<string>();
  const touched: string[] = [];
  const guard = (keys: readonly string[]) => {
    touched.push(...keys);
    if (keys.some(failing)) throw new RedisUnavailableError('command_failed');
  };
  const ns: RedisNamespace = {
    get: vi.fn(async (key: string) => {
      guard([key]);
      return null;
    }),
    set: vi.fn(async (key: string) => {
      guard([key]);
    }),
    eval: vi.fn(async (_script: string, options: { keys: readonly string[] }) => {
      guard(options.keys);
      const key = options.keys.join('|');
      if (reserved.has(key)) return null;
      reserved.add(key);
      return 'OK';
    }),
  };
  const redis: RedisHandle = {
    namespace: vi.fn(() => ns),
    close: async () => undefined,
    onApplicationShutdown: async () => undefined,
  };
  return { redis, reserved, touched };
}

export const notNonce = (key: string): boolean => !key.startsWith('nonce:');
export const everyKey = (): boolean => true;

/** REDIS_URL of the api entry for `url`. */
export function redisConnection(url: string) {
  return loadConnectionConfig('api', {
    DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/rules',
    REDIS_URL: url,
  });
}

export interface Server {
  url: string;
  stop(): Promise<void>;
}
export interface RawRedis {
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
  disconnect(): void;
}
export async function acquire(): Promise<Server> {
  const testing = (await import(new URL('packages/db/src/testing/index.ts', ROOT).href)) as {
    acquireTestRedis(): Promise<Server>;
  };
  return testing.acquireTestRedis();
}

/**
 * The shared test Redis forbids FLUSHDB on its database 0 (packages/db/src/testing/redis.ts). The
 * generation key is one key per Redis and 9.3 simulates data loss with FLUSHDB, so this suite owns
 * a database of its own: no other test file selects it, and FLUSHDB there touches nothing else.
 */
export const DB_INDEX = 13;
export function databaseUrl(url: string, index = DB_INDEX): string {
  const parsed = new URL(url);
  parsed.pathname = `/${String(index)}`;
  return parsed.href;
}

export async function keys(raw: RawRedis, pattern: string): Promise<string[]> {
  const found = new Set<string>();
  let cursor = '0';
  do {
    const page = (await raw.call('SCAN', cursor, 'MATCH', pattern, 'COUNT', 100)) as [
      string,
      string[],
    ];
    cursor = page[0];
    page[1].forEach((key) => found.add(key));
  } while (cursor !== '0');
  return [...found].sort();
}
