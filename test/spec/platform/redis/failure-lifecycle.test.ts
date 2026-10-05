import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createRedisHandle,
  RedisClosedError,
  RedisUnavailableError,
} from '../../../../apps/api/src/modules/platform/redis/index.ts';
import {
  ENTRIES,
  assertNoSecrets,
  connection,
  failure,
  fixture,
  memoryLogger,
  printable,
  transport,
} from './kit.ts';

afterEach(() => {
  vi.useRealTimers();
});

it('[ADR-0001 §4.2 #17][B1-01y §9.2] 两个入口各自持有连接，关闭一个不影响另一个', async () => {
  const firstDriver = transport();
  const secondDriver = transport();
  const first = await createRedisHandle(connection('api'), {
    logger: memoryLogger('api').logger,
    transportFactory: () => firstDriver,
  });
  let second: Awaited<ReturnType<typeof createRedisHandle>> = null;
  try {
    second = await createRedisHandle(connection('worker'), {
      logger: memoryLogger('worker').logger,
      transportFactory: () => secondDriver,
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
    await first!.close();
    secondDriver.call.mockResolvedValueOnce('worker value');
    expect(await second!.namespace('catalog').get('key')).toBe('worker value');
    expect(secondDriver.quit).not.toHaveBeenCalled();
    expect(secondDriver.disconnect).not.toHaveBeenCalled();
  } finally {
    await first?.close();
    await second?.close();
  }
});

it.each(ENTRIES)(
  '[ADR-0001 §4.2 #17][B1-01y §9.2] %s 使用自身配置，payout 不创建 Redis 连接',
  async (entry) => {
    const driver = transport();
    const factory = vi.fn(() => driver);
    const { logger } = memoryLogger(entry);
    const url = `redis://127.0.0.1:1/0?connectionName=${entry}`;
    const handle = await createRedisHandle(connection(entry, url), {
      logger,
      transportFactory: factory,
    });
    try {
      if (entry === 'payout') {
        expect(handle).toBeNull();
        expect(factory).not.toHaveBeenCalled();
      } else {
        expect(handle).not.toBeNull();
        expect(factory).toHaveBeenCalledExactlyOnceWith(url);
        await handle!.close();
        expect(driver.connect).not.toHaveBeenCalled();
        expect(driver.quit).not.toHaveBeenCalled();
      }
    } finally {
      await handle?.close();
    }
  },
);

it('[ADR-0001 §4.2 #17][B1-01y §9.2] 连接失败明确报错、清理连接，不自动重发', async () => {
  const driver = transport();
  driver.connect.mockRejectedValue(new Error('ECONNREFUSED'));
  const { logger } = memoryLogger();
  const handle = await createRedisHandle(connection(), { logger, transportFactory: () => driver });
  expect(handle).not.toBeNull();
  try {
    expect(driver.connect).not.toHaveBeenCalled();
    const error = await failure(() => handle!.namespace('catalog').get('key'));
    expect(error).toBeInstanceOf(RedisUnavailableError);
    expect(driver.connect).toHaveBeenCalledTimes(1);
    expect(driver.disconnect).toHaveBeenCalled();
    expect(driver.call).not.toHaveBeenCalled();
  } finally {
    await handle?.close();
  }
});

it.each(['get', 'set', 'eval'] as const)(
  '[ADR-0001 §4.2 #17][B1-01y §9.2] %s 命令失败不能伪装命中、成功或放行',
  async (operation) => {
    const { handle, driver } = await fixture();
    try {
      driver.call.mockClear();
      driver.call.mockRejectedValue(
        new Error('OOM command not allowed when used memory > maxmemory'),
      );
      const cache = handle.namespace('risk');
      const calls = {
        get: () => cache.get('key'),
        set: () => cache.set('key', 'value', 30),
        eval: () => cache.eval('return 1', { keys: ['key'], args: [], ttlSeconds: 30 }),
      };
      expect(await failure(calls[operation])).toBeInstanceOf(RedisUnavailableError);
      expect(driver.call).toHaveBeenCalledTimes(1);
      driver.call.mockResolvedValueOnce('v');
      expect(await cache.get('key')).toBe('v');
    } finally {
      await handle.close();
    }
  },
);

it('[ADR-0001 §4.2 #17][B1-01y §9.2] 连接超时有界，关闭底层连接', async () => {
  vi.useFakeTimers();
  const driver = transport();
  driver.connect.mockImplementation(() => new Promise(() => {}));
  const { logger } = memoryLogger();
  const handle = await createRedisHandle(connection(), {
    logger,
    transportFactory: () => driver,
    connectTimeoutMs: 25,
  });
  expect(handle).not.toBeNull();
  try {
    expect(driver.connect).not.toHaveBeenCalled();
    const pending = failure(() => handle!.namespace('catalog').get('key'));
    await vi.advanceTimersByTimeAsync(26);
    expect(await pending).toBeInstanceOf(RedisUnavailableError);
    expect(driver.disconnect).toHaveBeenCalled();
    expect(driver.call).not.toHaveBeenCalled();
    driver.connect.mockResolvedValueOnce(undefined);
    driver.call.mockResolvedValueOnce('recovered');
    expect(await handle!.namespace('catalog').get('key')).toBe('recovered');
    expect(driver.connect).toHaveBeenCalledTimes(2);
  } finally {
    await handle?.close();
  }
});

it('[B1-01y §9.2][B1-01y §10] 首次连接失败后下一次命令重新连接并成功', async () => {
  const { handle, driver } = await fixture();
  try {
    driver.connect.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const cache = handle.namespace('catalog');
    expect(await failure(() => cache.get('key'))).toBeInstanceOf(RedisUnavailableError);
    expect(driver.connect).toHaveBeenCalledTimes(1);
    expect(driver.disconnect).toHaveBeenCalled();
    expect(driver.call).not.toHaveBeenCalled();
    driver.call.mockResolvedValueOnce('v');
    expect(await cache.get('key')).toBe('v');
    expect(driver.connect).toHaveBeenCalledTimes(2);
    expect(driver.call).toHaveBeenCalledTimes(1);
  } finally {
    await handle.close();
  }
});

it('[ADR-0001 §4.2 #17][B1-01y §9.2] 命令无响应时按时失败，不等待驱动无限重试', async () => {
  vi.useFakeTimers();
  const { handle, driver } = await fixture({ commandTimeoutMs: 25 });
  try {
    driver.call.mockClear();
    driver.call.mockImplementation(() => new Promise(() => {}));
    const pending = failure(() => handle.namespace('catalog').get('key'));
    await vi.advanceTimersByTimeAsync(26);
    expect(await pending).toBeInstanceOf(RedisUnavailableError);
    expect(driver.call).toHaveBeenCalledTimes(1);
  } finally {
    await handle.close();
  }
});

it.each(['connect', 'command', 'quit'] as const)(
  '[ADR-0001 §4.2 #17][B1-01y §9.2] %s 报错和日志都不带原始或编码密码',
  async (phase) => {
    const password = `${createHash('sha256').update(`redis-rule-${phase}`).digest('hex').slice(0, 24)}@/`;
    const encoded = encodeURIComponent(password);
    const url = `redis://user:${encoded}@127.0.0.1:1/0`;
    const raw = new Error(`driver failed: ${url}; password=${password}`);
    const driver = transport();
    const { logger, lines } = memoryLogger();
    if (phase === 'connect') driver.connect.mockRejectedValue(raw);
    if (phase === 'command') driver.call.mockRejectedValue(raw);
    if (phase === 'quit') driver.quit.mockRejectedValue(raw);
    let handle: Awaited<ReturnType<typeof createRedisHandle>> = null;
    try {
      handle = await createRedisHandle(connection('api', url), {
        logger,
        transportFactory: () => driver,
      });
      expect(handle).not.toBeNull();
      const cache = handle!.namespace('catalog');
      // Connect before exercising QUIT; construction itself must never attempt a connection.
      expect(driver.connect).not.toHaveBeenCalled();
      const error = await failure(async () => {
        await cache.get('item');
        if (phase === 'quit') await handle!.close();
      });
      // A graceful-close error may be logged and force-disconnected; read/connect failures must reject.
      if (phase !== 'quit') expect(error).toBeInstanceOf(RedisUnavailableError);
      else expect(driver.disconnect).toHaveBeenCalled();
      assertNoSecrets(
        printable(error) +
          printable(handle) +
          printable(cache) +
          JSON.stringify(handle) +
          JSON.stringify(cache) +
          lines.join(''),
        [password, encoded],
      );
      for (const line of lines) {
        const record = JSON.parse(line) as Record<string, unknown>;
        expect(
          Object.values(record).every((value) => value === null || typeof value !== 'object'),
        ).toBe(true);
      }
    } finally {
      if (handle !== null) await failure(() => handle!.close());
    }
  },
);

it('[ADR-0001 §4.2 #17][B1-01y §9.2] 并行重复关闭只退出一次，旧命名空间不能继续读写或执行 Lua', async () => {
  const { handle, driver } = await fixture();
  const cache = handle.namespace('catalog');
  await cache.get('key');
  await Promise.all([handle.close(), handle.onApplicationShutdown(), handle.close()]);
  const before = driver.call.mock.calls.length;
  expect(driver.quit).toHaveBeenCalledTimes(1);
  for (const run of [
    () => cache.get('key'),
    () => cache.set('key', 'v', 2),
    () => cache.eval('return 1', { keys: ['key'], args: [], ttlSeconds: 2 }),
    () => handle.namespace('other').get('key'),
  ]) {
    const error = await failure(run);
    expect(error).toBeInstanceOf(RedisClosedError);
    expect(error).toBeInstanceOf(RedisUnavailableError);
  }
  expect(driver.call.mock.calls.length).toBe(before);
});

it('[ADR-0001 §4.2 #17][B1-01y §9.2] QUIT 挂住时有界退出并强制断开，关闭后仍拒绝命令', async () => {
  vi.useFakeTimers();
  const { handle, driver } = await fixture({ closeTimeoutMs: 25 });
  const cache = handle.namespace('catalog');
  await cache.get('key');
  driver.quit.mockImplementation(() => new Promise(() => {}));
  const pending = failure(() => handle.close());
  await vi.advanceTimersByTimeAsync(26);
  await pending;
  expect(driver.disconnect).toHaveBeenCalled();
  const error = await failure(() => cache.get('key'));
  expect(error).toBeInstanceOf(RedisClosedError);
  expect(error).toBeInstanceOf(RedisUnavailableError);
});
