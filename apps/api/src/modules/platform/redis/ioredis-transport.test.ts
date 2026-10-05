// Implementer unit tests of the ioredis transport (B1-01y §9.2, §10). Network-free: the
// driver is a stand-in, and the real ioredis client below is never connected.
import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConnectionConfig } from '../db/index.ts';
import { createRootLogger } from '../logging/index.ts';
import { RedisValidationError } from './errors.ts';
import { RedisUnavailableError, createRedisHandle, type RedisHandle } from './index.ts';
import {
  createIoredisTransport,
  ioredisPlan,
  type DriverClient,
  type DriverFactory,
} from './ioredis-transport.ts';

const SETTINGS = { connectionName: 'couli-api', connectTimeoutMs: 250 };

afterEach(() => {
  vi.useRealTimers();
});

class ReplyError extends Error {
  override name = 'ReplyError';
}

class FakeClient extends EventEmitter {
  status = 'wait';
  readonly connect = vi.fn(async () => {
    this.status = 'ready';
  });
  readonly call = vi.fn<(command: string, ...args: (string | number)[]) => Promise<unknown>>(
    async (command) => (command === 'PING' ? 'PONG' : 'OK'),
  );
  readonly quit = vi.fn(async (): Promise<unknown> => {
    this.status = 'end';
    this.emit('end');
    return 'OK';
  });
  readonly disconnect = vi.fn(() => {
    this.status = 'end';
    this.emit('end');
  });
}

/** `setup` adjusts each new client; `index` counts the clients this driver created. */
function fakeDriver(setup: (client: FakeClient, index: number) => void = () => {}) {
  const clients: FakeClient[] = [];
  const driver: DriverFactory = () => {
    const client = new FakeClient();
    setup(client, clients.length);
    clients.push(client);
    return client as DriverClient;
  };
  return { clients, driver };
}

/** Commands the transport sent on `client`, in order. */
function sent(client: FakeClient | undefined): unknown[][] {
  return client?.call.mock.calls ?? [];
}

async function failure(run: () => unknown): Promise<unknown> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error;
  }
}

it('[B1-01y §9.2] options: URL parts only, no reconnect, no offline queue, no built-in ready check', () => {
  const { options, database } = ioredisPlan(
    'rediss://cache-user:p%40ss%2Fword@[::1]:6380/3',
    SETTINGS,
  );
  expect(database).toBe(3);
  expect(options).toMatchObject({
    host: '::1',
    port: 6380,
    username: 'cache-user',
    password: 'p@ss/word',
    tls: {},
    connectionName: 'couli-api',
    connectTimeout: 250,
    lazyConnect: true,
    enableReadyCheck: false,
    enableOfflineQueue: false,
    enableAutoPipelining: false,
    autoResendUnfulfilledCommands: false,
    maxRetriesPerRequest: 0,
  });
  // SELECT belongs to connect(): ioredis would only emit 'error' on a refused SELECT.
  expect('db' in options).toBe(false);
  expect(options.retryStrategy?.(1)).toBeNull();
  expect(
    typeof options.reconnectOnError === 'function' && options.reconnectOnError(new Error('x')),
  ).toBe(false);
  const loopback = ioredisPlan('redis://127.0.0.1:1', SETTINGS);
  expect([loopback.options.host, loopback.options.port, loopback.database]).toEqual([
    '127.0.0.1',
    1,
    0,
  ]);
  const plain = ioredisPlan('redis://redis/', SETTINGS);
  expect([
    plain.options.port,
    plain.database,
    'password' in plain.options,
    'tls' in plain.options,
  ]).toEqual([6379, 0, false, false]);
});

it.each([
  'redis://127.0.0.1:1/x',
  'redis://127.0.0.1:1/01',
  'redis://127.0.0.1:1/0/1',
  'redis://127.0.0.1:1/0?db=2',
  'redis://127.0.0.1:1/0?enableOfflineQueue=true',
])('[B1-01y §9.2] a URL like %s is refused without echoing the URL', (url) => {
  let error: unknown;
  try {
    ioredisPlan(url.replace('127.0.0.1', 'u:hidden-pw@127.0.0.1'), SETTINGS);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(RedisValidationError);
  expect((error as Error).message.includes('hidden-pw')).toBe(false);
  expect((error as Error).message.includes('127.0.0.1')).toBe(false);
});

it('[B1-01y §9.2] a query string is refused when the transport is built, before any client', () => {
  const { clients, driver } = fakeDriver();
  expect(() => createIoredisTransport('redis://127.0.0.1:1/0?db=2', SETTINGS, driver)).toThrow(
    RedisValidationError,
  );
  expect(clients).toHaveLength(0);
});

it('[B1-01y §10] building the transport creates no client; each connect() uses a fresh one', async () => {
  const { clients, driver } = fakeDriver();
  const transport = createIoredisTransport('redis://127.0.0.1:1/0', SETTINGS, driver);
  expect(clients).toHaveLength(0);
  await transport.connect();
  transport.disconnect();
  await transport.connect();
  expect(clients).toHaveLength(2);
  expect(clients[0]?.disconnect).toHaveBeenCalledTimes(1);
  expect(await transport.call('GET', 'k')).toBe('OK');
  expect(sent(clients[1])).toEqual([['PING'], ['GET', 'k']]);
  expect(sent(clients[0])).toEqual([['PING']]);
});

it('[B1-01y §9.2] connect() selects the database of REDIS_URL, then PINGs, before any command', async () => {
  const { clients, driver } = fakeDriver();
  const transport = createIoredisTransport('redis://127.0.0.1:1/2', SETTINGS, driver);
  await transport.connect();
  expect(sent(clients[0])).toEqual([['SELECT', 2], ['PING']]);
  await transport.call('SET', 'k', 'v', 'EX', '5');
  expect(sent(clients[0])?.at(-1)).toEqual(['SET', 'k', 'v', 'EX', '5']);
});

it('[B1-01y §9.2] a refused SELECT fails connect(): the client is dropped and db 0 is never read or written', async () => {
  const refused = new ReplyError(
    "NOPERM User cache has no permissions to run the 'select' command",
  );
  const { clients, driver } = fakeDriver((client) => {
    client.call.mockImplementation(async (command) => {
      if (command === 'SELECT') throw refused;
      return command === 'PING' ? 'PONG' : 'OK';
    });
  });
  const transport = createIoredisTransport('redis://127.0.0.1:1/2', SETTINGS, driver);
  expect(await failure(() => transport.connect())).toBe(refused);
  expect(clients[0]?.disconnect).toHaveBeenCalledTimes(1);
  expect(await failure(() => transport.call('SET', 'k', 'v', 'EX', '5'))).toMatchObject({
    message: 'Redis connection is not open',
  });
  expect(sent(clients[0])).toEqual([['SELECT', 2]]);

  // Through the handle: the command rejects as unavailable and never reaches any client.
  const { logger } = memoryLogger();
  const handle = (await createRedisHandle(
    loadConnectionConfig('api', {
      DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unit',
      REDIS_URL: 'redis://127.0.0.1:1/2',
    }),
    {
      logger,
      transportFactory: (url) => createIoredisTransport(url, SETTINGS, driver),
    },
  )) as RedisHandle;
  try {
    const error = await failure(() => handle.namespace('catalog').set('key', 'v', 5));
    expect(error).toBeInstanceOf(RedisUnavailableError);
    expect(error).toMatchObject({ reason: 'connect_failed', code: 'NOPERM' });
    expect(clients).toHaveLength(2);
    expect(sent(clients[1])).toEqual([['SELECT', 2]]);
    expect(clients[1]?.disconnect).toHaveBeenCalledTimes(1);
  } finally {
    await handle.close();
  }
});

it('[B1-01y §9.2] an error event during the handshake fails connect() even if the driver resolves', async () => {
  // ioredis reports a refused handshake SELECT only as an 'error' event and still becomes ready.
  const refused = new ReplyError('ERR DB index is out of range');
  const { clients, driver } = fakeDriver((client, index) => {
    if (index > 0) return;
    client.connect.mockImplementationOnce(async () => {
      client.emit('error', refused);
      client.status = 'ready';
    });
  });
  const transport = createIoredisTransport('redis://127.0.0.1:1/0', SETTINGS, driver);
  expect(await failure(() => transport.connect())).toBe(refused);
  expect(clients[0]?.disconnect).toHaveBeenCalledTimes(1);
  await expect(transport.call('GET', 'k')).rejects.toThrow('Redis connection is not open');
  expect(sent(clients[0]).some(([command]) => command === 'GET')).toBe(false);
  // Errors after an established connection are absorbed by the listener, not thrown or printed.
  await transport.connect();
  expect(() => clients[1]?.emit('error', new Error('later'))).not.toThrow();
  expect(await transport.call('GET', 'k')).toBe('OK');
});

it('[B1-01y §9.2] the PING ready check must answer PONG: LOADING fails connect()', async () => {
  const loading = new ReplyError('LOADING Redis is loading the dataset in memory');
  const { clients, driver } = fakeDriver((client) => {
    client.call.mockImplementation(async (command) => {
      if (command === 'PING') throw loading;
      return 'OK';
    });
  });
  const transport = createIoredisTransport('redis://127.0.0.1:1/0', SETTINGS, driver);
  expect(await failure(() => transport.connect())).toBe(loading);
  expect(clients[0]?.disconnect).toHaveBeenCalledTimes(1);
  expect(sent(clients[0])).toEqual([['PING']]);
});

it.each([
  {
    command: 'SELECT',
    reply: 'QUEUED',
    url: 'redis://127.0.0.1:1/2',
    commands: [['SELECT', 2]],
    message: 'Redis SELECT was not confirmed',
  },
  {
    command: 'PING',
    reply: 'OK',
    url: 'redis://127.0.0.1:1/0',
    commands: [['PING']],
    message: 'Redis ready check got an unexpected reply',
  },
])(
  '[B1-01y §9.2] a handshake $command answered $reply fails connect() and drops the client',
  async ({ command, reply, url, commands, message }) => {
    const { clients, driver } = fakeDriver((client) => {
      client.call.mockImplementation(async (sentCommand) => {
        if (sentCommand === command) return reply;
        return sentCommand === 'PING' ? 'PONG' : 'OK';
      });
    });
    const transport = createIoredisTransport(url, SETTINGS, driver);
    expect(await failure(() => transport.connect())).toMatchObject({ message });
    expect(clients[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(sent(clients[0])).toEqual(commands);
    await expect(transport.call('GET', 'k')).rejects.toThrow('Redis connection is not open');
  },
);

it('[B1-01y §9.2] disconnect() during the handshake wins over a late PONG; nothing is reported lost', async () => {
  let answer: (reply: unknown) => void = () => {};
  const { clients, driver } = fakeDriver((client) => {
    client.call.mockImplementation((command) =>
      command === 'PING'
        ? new Promise<unknown>((resolve) => {
            answer = resolve;
          })
        : Promise.resolve('OK'),
    );
  });
  const transport = createIoredisTransport('redis://127.0.0.1:1/0', SETTINGS, driver);
  const lost = vi.fn();
  transport.onConnectionLost?.(lost);
  const pending = failure(() => transport.connect());
  await vi.waitFor(() => {
    expect(sent(clients[0])).toEqual([['PING']]);
  });
  transport.disconnect();
  answer('PONG');
  expect(await pending).toMatchObject({
    message: 'Redis connection was closed while connecting',
  });
  await expect(transport.call('GET', 'k')).rejects.toThrow('Redis connection is not open');
  expect(lost).not.toHaveBeenCalled();
  expect(clients[0]?.disconnect).toHaveBeenCalledTimes(1);
  expect(sent(clients[0])).toEqual([['PING']]);
});

it('[B1-01y §9.2] the handshake is bounded by connectTimeoutMs as a whole', async () => {
  vi.useFakeTimers();
  const { clients, driver } = fakeDriver((client) => {
    client.call.mockImplementation(() => new Promise(() => {}));
  });
  const transport = createIoredisTransport('redis://127.0.0.1:1/0', SETTINGS, driver);
  const pending = failure(() => transport.connect());
  await vi.advanceTimersByTimeAsync(SETTINGS.connectTimeoutMs + 1);
  expect(await pending).toMatchObject({ code: 'ETIMEDOUT' });
  expect(clients[0]?.disconnect).toHaveBeenCalledTimes(1);
  expect(sent(clients[0])).toEqual([['PING']]);
  expect(vi.getTimerCount()).toBe(0);
});

it('[B1-01y §10] a failed connect rejects with the socket error and drops the client', async () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const { clients, driver } = fakeDriver((client) => {
    client.connect.mockImplementationOnce(async () => {
      client.emit('error', refused);
      throw new Error('Connection is closed.');
    });
  });
  const transport = createIoredisTransport('redis://127.0.0.1:1/0', SETTINGS, driver);
  await expect(transport.connect()).rejects.toBe(refused);
  expect(clients[0]?.disconnect).toHaveBeenCalled();
  await expect(transport.call('GET', 'k')).rejects.toThrow('Redis connection is not open');
});

it('[B1-01y §9.2] only the end of an established current connection is reported as lost', async () => {
  const { clients, driver } = fakeDriver();
  const transport = createIoredisTransport('redis://127.0.0.1:1/0', SETTINGS, driver);
  const lost = vi.fn();
  transport.onConnectionLost?.(lost);
  await transport.connect();
  clients[0]?.emit('end');
  expect(lost).toHaveBeenCalledTimes(1);
  await transport.connect();
  await transport.quit();
  await transport.connect();
  transport.disconnect();
  expect(lost).toHaveBeenCalledTimes(1);
  expect(clients[1]?.quit).toHaveBeenCalledTimes(1);
});

it('[B1-01y §10] QUIT goes only to a ready connection; disconnect() also ends a hanging QUIT', async () => {
  const { clients, driver } = fakeDriver();
  const transport = createIoredisTransport('redis://127.0.0.1:1/0', SETTINGS, driver);
  await transport.connect();
  clients[0]!.status = 'close';
  await transport.quit();
  expect(clients[0]?.quit).not.toHaveBeenCalled();
  expect(clients[0]?.disconnect).toHaveBeenCalledTimes(1);

  await transport.connect();
  clients[1]?.quit.mockImplementationOnce(() => new Promise(() => {}));
  void transport.quit();
  transport.disconnect();
  expect(clients[1]?.disconnect).toHaveBeenCalledTimes(1);
});

it('[B1-01y §10] a refused QUIT forces the client shut; repeated close calls stay safe', async () => {
  const { clients, driver } = fakeDriver();
  const transport = createIoredisTransport('redis://127.0.0.1:1/0', SETTINGS, driver);
  await transport.connect();
  const refused = new ReplyError("NOPERM User cache has no permissions to run the 'quit' command");
  // An ACL refusal leaves the socket open: the driver neither ends nor disconnects by itself.
  clients[0]?.quit.mockRejectedValueOnce(refused);
  expect(await failure(() => transport.quit())).toBe(refused);
  expect(clients[0]?.disconnect).toHaveBeenCalledTimes(1);
  expect(clients[0]?.status).toBe('end');
  transport.disconnect();
  expect(await transport.quit()).toBeUndefined();
  transport.disconnect();
  expect(clients[0]?.disconnect).toHaveBeenCalledTimes(1);
  expect(clients[0]?.quit).toHaveBeenCalledTimes(1);

  // Through the handle: close() logs the refusal and the client still ends up disconnected.
  const { logger, lines } = memoryLogger();
  const handle = (await createRedisHandle(
    loadConnectionConfig('api', {
      DATABASE_URL: 'postgres://couli_app@127.0.0.1:1/unit',
      REDIS_URL: 'redis://127.0.0.1:1/0',
    }),
    { logger, transportFactory: (url) => createIoredisTransport(url, SETTINGS, driver) },
  )) as RedisHandle;
  await handle.namespace('catalog').get('key');
  clients[1]?.quit.mockRejectedValueOnce(refused);
  await Promise.all([handle.close(), handle.close()]);
  await handle.close();
  expect(clients[1]?.quit).toHaveBeenCalledTimes(1);
  expect(clients[1]?.disconnect).toHaveBeenCalledTimes(1);
  expect(lines.map((line) => [line['msg'], line['reason'], line['code']])).toEqual([
    ['redis_close_failed', 'quit_failed', 'NOPERM'],
  ]);
});

it('[B1-01y §10] a real ioredis client from these options stays offline until connect()', () => {
  const client = new Redis(ioredisPlan('redis://127.0.0.1:1/0', SETTINGS).options);
  const errors: unknown[] = [];
  client.on('error', (error: unknown) => errors.push(error));
  expect(client.status).toBe('wait');
  client.disconnect();
  expect(client.status).not.toBe('connecting');
  expect(errors).toEqual([]);
});

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
