import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { expect } from 'vitest';
import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import { loadConnectionConfig } from '../../../../apps/api/src/modules/platform/db/index.ts';
import { createRootLogger } from '../../../../apps/api/src/modules/platform/logging/logger.ts';
import {
  createRedisHandle,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import {
  createSmsCodeService,
  type SmsCodeOptions,
  type SmsResult,
  type SmsPurpose,
} from '../../../../apps/api/src/modules/identity/application/sms-codes.ts';
import { createFakeSmsSender } from '../../../../apps/api/src/modules/identity/infra/fake-sms.ts';

export interface TestRedis {
  url: string;
  stop(): Promise<void>;
}
export async function acquireRedis(): Promise<TestRedis | undefined> {
  const testing = (await import(
    new URL('../../../../packages/db/src/testing/index.ts', import.meta.url).href
  )) as Record<string, unknown>;
  const acquire = testing['acquireTestRedis'];
  if (typeof acquire === 'function') return (acquire as () => Promise<TestRedis>)();
  return undefined;
}
export function phone(prefix = '139'): string {
  return prefix + Array.from({ length: 11 - prefix.length }, () => randomInt(10)).join('');
}
export function makeHmac(): (text: string) => string {
  const key = randomBytes(32);
  return (text) => createHmac('sha256', key).update(text).digest('hex');
}
export function fullWidthPhone(number: string): string {
  return `86${number}`.replace(/[0-9]/g, (digit) =>
    String.fromCharCode(digit.charCodeAt(0) + 0xfee0),
  );
}
export function memoryLogger() {
  const lines: string[] = [];
  const logger = createRootLogger(
    { level: 'trace', entry: 'api', appEnv: 'test' },
    { write: (line: string) => void lines.push(line) },
  );
  return { logger, lines };
}
export function redisConnection(url: string) {
  return loadConnectionConfig('api', {
    DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/rules',
    REDIS_URL: url,
  });
}
export async function fixture(server: TestRedis, overrides: Partial<SmsCodeOptions> = {}) {
  const { logger, lines } = memoryLogger();
  const redis = await createRedisHandle(redisConnection(server.url), { logger });
  expect(redis === null).toBe(false);
  try {
    const clock = new FixedClock('2026-10-06T10:00:00+08:00');
    const sender = createFakeSmsSender('test');
    const options: SmsCodeOptions = {
      clock,
      redis: redis as RedisHandle,
      sender,
      logger,
      config: { configValue: async () => null },
      hmac: makeHmac(),
      ...overrides,
    };
    const service = createSmsCodeService(options);
    const number = phone();
    const send = (purpose: SmsPurpose = 'login', input = number, appId = 'couli') =>
      service.send({ app_id: appId, phone: input, purpose });
    const verify = (code: string, purpose: SmsPurpose = 'login', input = number, appId = 'couli') =>
      service.verifyAndConsume({ app_id: appId, phone: input, purpose, code });
    const lastCode = () => {
      const message = sender.outbox().at(-1);
      expect(message).toBeDefined();
      expect(message!.code).toMatch(/^[0-9]{6}$/);
      return message!.code;
    };
    return {
      clock,
      sender,
      service,
      number,
      send,
      verify,
      lastCode,
      options,
      lines,
      close: () => redis!.close(),
    };
  } catch (error) {
    await redis!.close();
    throw error;
  }
}
export async function withFixture(
  server: TestRedis,
  run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  overrides: Partial<SmsCodeOptions> = {},
) {
  const f = await fixture(server, overrides);
  try {
    await run(f);
  } finally {
    await f.close();
  }
}
export function success(result: SmsResult): void {
  expect(result.code).toBe(0);
  expect(result).toMatchObject({ data: { expires_in_sec: 300 } });
}
export function limited(result: SmsResult, seconds?: number): void {
  expect(result.code).toBe(42901);
  expect(result).toHaveProperty('retryAfterSec');
  if (result.code !== 42901) return;
  expect(Number.isInteger(result.retryAfterSec)).toBe(true);
  expect(result.retryAfterSec).toBeGreaterThanOrEqual(1);
  if (seconds !== undefined) expect(result.retryAfterSec).toBe(seconds);
}
export function wrong(code: string): string {
  return code === '000000' ? '000001' : '000000';
}
