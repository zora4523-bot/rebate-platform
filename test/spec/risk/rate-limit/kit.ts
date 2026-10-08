import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  createRedisHandle,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import {
  createRateLimitService,
  createRateLimitThresholdReader,
  type RateLimitOptions,
  type RateLimitRequest,
  type RateLimitResult,
} from '../../../../apps/api/src/modules/risk/index.ts';
import { memoryLogger, redisConnection } from '../../identity/sms-codes/kit.ts';

export const ROOT = new URL('../../../../', import.meta.url);
export const apiRequire = createRequire(new URL('apps/api/package.json', ROOT));
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
export function appId(): string {
  return `rl_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}
export function request(app = appId(), operationId = 'searchProducts'): RateLimitRequest {
  return {
    entry: 'api',
    app_id: app,
    operationId,
    client_ip: '192.0.2.10',
    principal: {
      uid: randomUUID(),
      device_id: randomUUID(),
      app_id: app,
      sid: randomUUID(),
      scp: 'full',
    },
  };
}
export function allowed(result: RateLimitResult): void {
  expect(result).toEqual({ code: 0 });
}
export function denied(result: RateLimitResult, seconds: number): void {
  expect(result).toEqual({ code: 42901, retryAfterSec: seconds });
  if (result.code === 42901) {
    expect(Number.isInteger(result.retryAfterSec)).toBe(true);
    expect(result.retryAfterSec).toBeGreaterThanOrEqual(1);
  }
}
export async function withRedis(server: Server, run: (f: RedisFixture) => Promise<void>) {
  const { logger, lines } = memoryLogger();
  const handles: RedisHandle[] = [];
  const { Redis } = apiRequire('ioredis') as {
    Redis: new (url: string, options: object) => RawRedis;
  };
  const raw = new Redis(server.url, { maxRetriesPerRequest: 0, retryStrategy: () => null });
  const app = appId();
  const clock = new FixedClock('2031-05-06T07:08:59.500Z');
  const values = new Map<string, unknown>();
  const reads: string[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const handle = await createRedisHandle(redisConnection(server.url), { logger });
      expect(handle).not.toBeNull();
      handles.push(handle!);
    }
    const options: RateLimitOptions = {
      redis: handles[0]!,
      clock,
      logger,
      thresholds: createRateLimitThresholdReader({
        async configValue(id, key) {
          reads.push(`${id}:${key}`);
          return values.has(`${id}:${key}`)
            ? { value: values.get(`${id}:${key}`), version: 1 }
            : null;
        },
      }),
    };
    await run({
      app,
      clock,
      raw,
      handles,
      options,
      lines,
      reads,
      config: (key, value, id = app) => {
        values.set(`${id}:${key}`, value);
      },
      // Construct inside each test: NotImplemented must never be a setup-hook failure.
      service: (overrides = {}) => createRateLimitService({ ...options, ...overrides }),
      keys: () => keys(raw, `rl:${app}*`),
    });
  } finally {
    try {
      const owned = await keys(raw, `rl:${app}*`);
      if (owned.length > 0) await raw.call('DEL', ...owned);
    } finally {
      raw.disconnect();
      await Promise.all(handles.map((h) => h.close()));
    }
  }
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
export interface RedisFixture {
  app: string;
  clock: FixedClock;
  raw: RawRedis;
  handles: RedisHandle[];
  options: RateLimitOptions;
  lines: string[];
  reads: string[];
  config(key: string, value: unknown, app?: string): void;
  service(overrides?: Partial<RateLimitOptions>): ReturnType<typeof createRateLimitService>;
  keys(): Promise<string[]>;
}
