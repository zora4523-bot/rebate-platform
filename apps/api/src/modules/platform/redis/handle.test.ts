// Implementer unit tests of the Redis handle (B1-01y §9.2); the rules are in
// test/spec/platform/redis/**. Network-free: every transport here is a stand-in.
import { expect, it, vi } from 'vitest';
import { loadConnectionConfig } from '../db/index.ts';
import { createRootLogger } from '../logging/index.ts';
import {
  REDIS_TIMEOUT_DEFAULTS,
  RedisClosedError,
  RedisUnavailableError,
  RedisValidationError,
  createRedisHandle,
  type RedisHandle,
  type RedisOptions,
  type RedisTransport,
} from './index.ts';

function connection(url = 'redis://127.0.0.1:1/0') {
  return loadConnectionConfig('api', {
    DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unit',
    REDIS_URL: url,
  });
}

function memoryLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = createRootLogger(
    { entry: 'api', appEnv: 'test', level: 'trace' },
    {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { logger, lines };
}

function transport() {
  let lost: (() => void) | undefined;
  const driver = {
    connect: vi.fn<RedisTransport['connect']>().mockResolvedValue(undefined),
    call: vi.fn<RedisTransport['call']>().mockResolvedValue('OK'),
    quit: vi.fn<RedisTransport['quit']>().mockResolvedValue('OK'),
    disconnect: vi.fn<RedisTransport['disconnect']>(),
    onConnectionLost: vi.fn((listener: () => void) => {
      lost = listener;
    }),
  };
  return { driver, loseConnection: () => lost?.() };
}

async function fixture(overrides: Partial<RedisOptions> = {}, url?: string) {
  const { driver, loseConnection } = transport();
  const { logger, lines } = memoryLogger();
  const handle = (await createRedisHandle(connection(url), {
    logger,
    transportFactory: () => driver,
    ...overrides,
  })) as RedisHandle;
  return { handle, driver, loseConnection, lines };
}

async function failure(run: () => unknown): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

class ReplyError extends Error {
  override name = 'ReplyError';
}

it.each([0, -1, 1.5, 60_001, Number.NaN])(
  '[B1-01y §9.2] timeout option %s is refused before a transport exists',
  async (value) => {
    const factory = vi.fn(() => transport().driver);
    for (const name of ['connectTimeoutMs', 'commandTimeoutMs', 'closeTimeoutMs'] as const) {
      const error = await failure(() =>
        createRedisHandle(connection(), {
          logger: memoryLogger().logger,
          transportFactory: factory,
          [name]: value,
        }),
      );
      expect(error).toBeInstanceOf(RedisValidationError);
    }
    expect(factory).not.toHaveBeenCalled();
  },
);

it('[B1-01y §9.2] defaults bound connect, command and close', () => {
  expect(REDIS_TIMEOUT_DEFAULTS).toEqual({
    connectTimeoutMs: 1_000,
    commandTimeoutMs: 1_000,
    closeTimeoutMs: 5_000,
  });
});

it('[B1-01y §9.2] an error reply keeps the connection and reports its prefix only', async () => {
  const { handle, driver } = await fixture();
  try {
    driver.call.mockRejectedValueOnce(
      new ReplyError('WRONGTYPE Operation against a key holding the wrong kind of value'),
    );
    const error = await failure(() => handle.namespace('catalog').get('list'));
    expect(error).toBeInstanceOf(RedisUnavailableError);
    expect(error).toMatchObject({ reason: 'command_failed', code: 'WRONGTYPE' });
    expect((error as Error).message).toBe('Redis unavailable: command_failed (WRONGTYPE)');
    expect(Object.hasOwn(error as object, 'cause')).toBe(false);
    driver.call.mockResolvedValueOnce('v');
    expect(await handle.namespace('catalog').get('key')).toBe('v');
    expect(driver.connect).toHaveBeenCalledTimes(1);
    expect(driver.disconnect).not.toHaveBeenCalled();
  } finally {
    await handle.close();
  }
});

it('[B1-01y §9.2] any other command failure drops the connection; the next command reconnects', async () => {
  const { handle, driver } = await fixture();
  try {
    driver.call.mockRejectedValueOnce(new Error('Connection is closed.'));
    const error = await failure(() => handle.namespace('catalog').get('key'));
    expect(error).toMatchObject({ reason: 'command_failed', code: null });
    expect(driver.disconnect).toHaveBeenCalledTimes(1);
    driver.call.mockResolvedValueOnce('v');
    expect(await handle.namespace('catalog').get('key')).toBe('v');
    expect(driver.connect).toHaveBeenCalledTimes(2);
  } finally {
    await handle.close();
  }
});

it('[B1-01y §9.2] concurrent first commands share one connection attempt', async () => {
  const { handle, driver } = await fixture();
  try {
    let open = (): void => {};
    driver.connect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          open = resolve;
        }),
    );
    driver.call.mockResolvedValueOnce('a').mockResolvedValueOnce('b');
    const cache = handle.namespace('catalog');
    const reads = Promise.all([cache.get('a'), cache.get('b')]);
    await vi.waitFor(() => {
      expect(driver.connect).toHaveBeenCalledTimes(1);
    });
    open();
    expect(await reads).toEqual(['a', 'b']);
    expect(driver.connect).toHaveBeenCalledTimes(1);
  } finally {
    await handle.close();
  }
});

it('[B1-01y §9.2] a connection lost while idle is re-opened before the next command', async () => {
  const { handle, driver, loseConnection, lines } = await fixture();
  try {
    const cache = handle.namespace('catalog');
    await cache.get('key');
    loseConnection();
    driver.call.mockResolvedValueOnce('again');
    expect(await cache.get('key')).toBe('again');
    expect(driver.connect).toHaveBeenCalledTimes(2);
    expect(lines.map((line) => line['msg'])).toEqual(['redis_connection_lost']);
  } finally {
    await handle.close();
  }
});

it('[B1-01y §9.2] close() while connecting rejects the command as closed and sends no QUIT', async () => {
  const { handle, driver } = await fixture();
  let open = (): void => {};
  driver.connect.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        open = resolve;
      }),
  );
  const pending = failure(() => handle.namespace('catalog').get('key'));
  await vi.waitFor(() => {
    expect(driver.connect).toHaveBeenCalledTimes(1);
  });
  await handle.close();
  open();
  expect(await pending).toBeInstanceOf(RedisClosedError);
  expect(driver.quit).not.toHaveBeenCalled();
  expect(driver.call).not.toHaveBeenCalled();
  expect(driver.disconnect).toHaveBeenCalled();
});

it('[B1-01y §9.2] a late failure of a first-generation command never drops the second connection', async () => {
  const { handle, driver, loseConnection } = await fixture();
  try {
    const cache = handle.namespace('catalog');
    let breakFirst: (error: Error) => void = () => {};
    driver.call.mockImplementationOnce(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          breakFirst = reject;
        }),
    );
    const first = failure(() => cache.get('first'));
    await vi.waitFor(() => {
      expect(driver.call).toHaveBeenCalledTimes(1);
    });
    loseConnection();
    driver.call.mockResolvedValueOnce('second');
    expect(await cache.get('second')).toBe('second');
    expect(driver.connect).toHaveBeenCalledTimes(2);
    // The first generation's socket error arrives only now, after the second connection exists.
    breakFirst(new Error('Connection is closed.'));
    expect(await first).toMatchObject({ reason: 'command_failed' });
    expect(driver.disconnect).not.toHaveBeenCalled();
    driver.call.mockResolvedValueOnce('third');
    expect(await cache.get('third')).toBe('third');
    expect(driver.connect).toHaveBeenCalledTimes(2);
  } finally {
    await handle.close();
  }
});

it('[B1-01y §9.2] after a command timeout the next command opens a new connection', async () => {
  vi.useFakeTimers();
  try {
    const { handle, driver } = await fixture({ commandTimeoutMs: 25 });
    try {
      const cache = handle.namespace('catalog');
      driver.call.mockImplementationOnce(() => new Promise(() => {}));
      const pending = failure(() => cache.get('key'));
      await vi.advanceTimersByTimeAsync(26);
      expect(await pending).toMatchObject({ reason: 'command_timeout' });
      expect(driver.disconnect).toHaveBeenCalledTimes(1);
      driver.call.mockResolvedValueOnce('fresh');
      expect(await cache.get('key')).toBe('fresh');
      expect(driver.connect).toHaveBeenCalledTimes(2);
    } finally {
      await handle.close();
    }
  } finally {
    vi.useRealTimers();
  }
});

it('[B1-01y §9.2] close() before the transport is asked to connect opens nothing', async () => {
  const { handle, driver } = await fixture();
  // The first command schedules its connection attempt; close() runs before that turn.
  const pending = failure(() => handle.namespace('catalog').get('key'));
  const closed = handle.close();
  expect(await pending).toBeInstanceOf(RedisClosedError);
  await closed;
  expect(driver.connect).not.toHaveBeenCalled();
  expect(driver.call).not.toHaveBeenCalled();
  expect(driver.quit).not.toHaveBeenCalled();
});

it('[B1-01y §9.2] a command that times out after close() reports the handle as closed', async () => {
  vi.useFakeTimers();
  try {
    const { handle, driver } = await fixture({ commandTimeoutMs: 25, closeTimeoutMs: 50 });
    await handle.namespace('catalog').get('key');
    driver.call.mockImplementationOnce(() => new Promise(() => {}));
    const pending = failure(() => handle.namespace('catalog').get('key'));
    // Let the command reach the transport without getting near its 25 ms timeout.
    await vi.advanceTimersByTimeAsync(1);
    expect(driver.call).toHaveBeenCalledTimes(2);
    const closed = handle.close();
    await vi.advanceTimersByTimeAsync(26);
    expect(await pending).toBeInstanceOf(RedisClosedError);
    await closed;
  } finally {
    vi.useRealTimers();
  }
});

it('[B1-01y §9.2] replies of the wrong shape are not reported as a hit or a write', async () => {
  const { handle, driver } = await fixture();
  try {
    const cache = handle.namespace('catalog');
    driver.call.mockResolvedValueOnce(42);
    expect(await failure(() => cache.get('key'))).toMatchObject({ reason: 'unexpected_reply' });
    driver.call.mockResolvedValueOnce(null);
    expect(await failure(() => cache.set('key', 'v', 5))).toMatchObject({
      reason: 'unexpected_reply',
    });
  } finally {
    await handle.close();
  }
});

it('[B1-01y §9.2] keys and values are checked before any command', async () => {
  const { handle, driver } = await fixture();
  try {
    const cache = handle.namespace('catalog');
    for (const run of [
      () => cache.get(''),
      () => cache.get(7 as unknown as string),
      () => cache.set('key', 7 as unknown as string, 5),
      () => cache.eval('', { keys: [], args: [], ttlSeconds: 5 }),
      () => cache.eval('return 1', { keys: [''], args: [], ttlSeconds: 5 }),
      () => cache.eval('return 1', { keys: [], args: [1 as unknown as string], ttlSeconds: 5 }),
      () => cache.eval('return 1', { keys: 'k' as unknown as string[], args: [], ttlSeconds: 5 }),
    ]) {
      expect(await failure(run)).toBeInstanceOf(RedisValidationError);
    }
    expect(driver.connect).not.toHaveBeenCalled();
    expect(driver.call).not.toHaveBeenCalled();
  } finally {
    await handle.close();
  }
});

it('[B1-01y §9.2] connect failures log once per outage with flat fields, then the recovery', async () => {
  const { handle, driver, lines } = await fixture();
  try {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
    });
    driver.connect.mockRejectedValueOnce(refused).mockRejectedValueOnce(refused);
    const cache = handle.namespace('catalog');
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await failure(() => cache.get('key'))).toMatchObject({
        reason: 'connect_failed',
        code: 'ECONNREFUSED',
      });
    }
    expect(await cache.get('key')).toBe('OK');
    expect(lines.map(({ level, msg, reason, code }) => ({ level, msg, reason, code }))).toEqual([
      { level: 40, msg: 'redis_connect_failed', reason: 'connect_failed', code: 'ECONNREFUSED' },
      { level: 30, msg: 'redis_reconnected', reason: undefined, code: undefined },
    ]);
  } finally {
    await handle.close();
  }
});

it('[B1-01y §9.2] a code that occurs in the password is dropped', async () => {
  const { handle, driver, lines } = await fixture({}, 'redis://u:XQUOTAKEYX@127.0.0.1:1/0');
  try {
    driver.connect.mockRejectedValueOnce(new Error('QUOTAKEY was rejected'));
    const error = await failure(() => handle.namespace('catalog').get('key'));
    expect(error).toMatchObject({ reason: 'connect_failed', code: null });
    expect(JSON.stringify(lines).includes('QUOTAKEY')).toBe(false);
  } finally {
    await handle.close();
  }
});

it('[B1-01y §9.2] a QUIT failure is logged with flat fields and forces a disconnect', async () => {
  const { handle, driver, lines } = await fixture();
  await handle.namespace('catalog').get('key');
  driver.quit.mockRejectedValueOnce(new Error('socket hang up'));
  await handle.close();
  expect(driver.disconnect).toHaveBeenCalledTimes(1);
  expect(lines).toEqual([
    expect.objectContaining({
      level: 40,
      msg: 'redis_close_failed',
      reason: 'quit_failed',
      code: null,
    }),
  ]);
  expect(await failure(() => handle.namespace('catalog'))).toBeInstanceOf(RedisClosedError);
});
