// Only the orchestrator runs this file: a real connection attempt to a closed loopback port.
import { afterEach, expect, it, vi } from 'vitest';
import {
  createRedisHandle,
  RedisUnavailableError,
  type RedisHandle,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import { assertNoSecrets, connection, failure, memoryLogger, printable } from './kit.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

it('[B1-01y §9.2][B1-01y §10] 真实驱动连接失败有界，错误与日志不泄露密码、不输出 console', async () => {
  const password = 'redis-rule-real-driver@/secret';
  const encoded = encodeURIComponent(password);
  const output = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const spies = output.map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
  const { logger, lines } = memoryLogger();
  let handle: RedisHandle | null = null;
  try {
    handle = await createRedisHandle(connection('api', `redis://u:${encoded}@127.0.0.1:1/0`), {
      logger,
      connectTimeoutMs: 50,
      commandTimeoutMs: 50,
      closeTimeoutMs: 50,
    });
    expect(handle).not.toBeNull();
    const cache = handle!.namespace('catalog');
    const started = performance.now();
    const error = await failure(() => cache.get('key'));
    expect(error instanceof RedisUnavailableError).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
    await handle!.close();
    // Observe delayed ioredis error events as well as the initial connection rejection.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertNoSecrets(
      printable(error) +
        printable(handle) +
        printable(cache) +
        JSON.stringify(handle) +
        JSON.stringify(cache) +
        lines.join('') +
        spies.map((spy) => printable(spy.mock.calls)).join(''),
      [password, encoded],
    );
    // Boolean assertions keep accidental driver credentials out of Vitest diagnostics.
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  } finally {
    if (handle !== null) await failure(() => handle!.close());
  }
}, 5000);
