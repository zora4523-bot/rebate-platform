// B1-01y §9.1–9.3 / ADR-0001 §2, §4.2 #17; review decisions in B1-01y §10.
import { inspect } from 'node:util';
import { expect, vi } from 'vitest';
import { loadConnectionConfig } from '../../../../apps/api/src/modules/platform/db/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import {
  createRedisHandle,
  type RedisHandle,
  type RedisOptions,
  type RedisTransport,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';

export const ENTRIES = ['api', 'stream', 'admin', 'worker', 'payout'] as const;
export type Entry = (typeof ENTRIES)[number];

export function connection(entry: Entry = 'api', url = 'redis://127.0.0.1:1/0') {
  return loadConnectionConfig(entry, {
    DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/rules',
    DATABASE_READ_URL: 'postgres://couli_readonly@127.0.0.1:1/rules',
    REDIS_URL: url,
  });
}

export function memoryLogger(entry: Entry = 'api') {
  const lines: string[] = [];
  const logger = createRootLogger(
    { entry, appEnv: 'test', level: 'trace' },
    {
      write: (line: string) => {
        lines.push(line);
      },
    },
  );
  return { logger, lines };
}

export function transport() {
  return {
    connect: vi.fn<RedisTransport['connect']>().mockResolvedValue(undefined),
    call: vi.fn<RedisTransport['call']>().mockResolvedValue('OK'),
    quit: vi.fn<RedisTransport['quit']>().mockResolvedValue('OK'),
    disconnect: vi.fn<RedisTransport['disconnect']>(),
  };
}

export async function fixture(overrides: Partial<RedisOptions> = {}) {
  const driver = transport();
  const { logger, lines } = memoryLogger();
  const handle = await createRedisHandle(connection(), {
    logger,
    transportFactory: () => driver,
    ...overrides,
  });
  expect(handle).not.toBeNull();
  return { handle: handle as RedisHandle, driver, lines };
}

/** Captures either sync throws or promise rejections; success remains distinguishable. */
export async function failure(run: () => unknown): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

export function printable(value: unknown): string {
  return inspect(value, { depth: 12, showHidden: true });
}

export function assertNoSecrets(text: string, secrets: readonly string[]): void {
  // Only booleans reach Vitest: never print an injected TEST_REDIS_URL in a failed assertion.
  expect(secrets.some((secret) => text.includes(secret))).toBe(false);
}

/** Invalid URLs must not expose the input (which may contain credentials) in TypeError. */
export function serviceUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error('Invalid test Redis service URL');
  }
}
