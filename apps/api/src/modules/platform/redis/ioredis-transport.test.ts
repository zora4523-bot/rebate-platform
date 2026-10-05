// Implementer unit tests of the ioredis transport (B1-01y §9.2, §10). Network-free: the
// driver is a stand-in, and the real ioredis client below is never connected.
import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import { expect, it, vi } from 'vitest';
import { RedisValidationError } from './errors.ts';
import {
  createIoredisTransport,
  ioredisOptions,
  type DriverClient,
  type DriverFactory,
} from './ioredis-transport.ts';

const SETTINGS = { connectionName: 'couli-api', connectTimeoutMs: 250 };

class FakeClient extends EventEmitter {
  status = 'wait';
  readonly connect = vi.fn(async () => {
    this.status = 'ready';
  });
  readonly call = vi.fn<(command: string, ...args: (string | number)[]) => Promise<unknown>>(
    async () => 'OK',
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

function fakeDriver() {
  const clients: FakeClient[] = [];
  const driver: DriverFactory = () => {
    const client = new FakeClient();
    clients.push(client);
    return client as DriverClient;
  };
  return { clients, driver };
}

it('[B1-01y §9.2] options: URL parts only, no reconnect, no offline queue, no resend', () => {
  const options = ioredisOptions(
    'rediss://cache-user:p%40ss%2Fword@[::1]:6380/3?enableOfflineQueue=true',
    SETTINGS,
  );
  expect(options).toMatchObject({
    host: '::1',
    port: 6380,
    db: 3,
    username: 'cache-user',
    password: 'p@ss/word',
    tls: {},
    connectionName: 'couli-api',
    connectTimeout: 250,
    lazyConnect: true,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    enableAutoPipelining: false,
    autoResendUnfulfilledCommands: false,
    maxRetriesPerRequest: 0,
  });
  expect(options.retryStrategy?.(1)).toBeNull();
  expect(
    typeof options.reconnectOnError === 'function' && options.reconnectOnError(new Error('x')),
  ).toBe(false);
  expect(ioredisOptions('redis://127.0.0.1:1', SETTINGS)).toMatchObject({
    host: '127.0.0.1',
    port: 1,
    db: 0,
  });
  const plain = ioredisOptions('redis://redis/', SETTINGS);
  expect([plain.port, plain.db, 'password' in plain, 'tls' in plain]).toEqual([
    6379,
    0,
    false,
    false,
  ]);
});

it.each(['redis://127.0.0.1:1/x', 'redis://127.0.0.1:1/01', 'redis://127.0.0.1:1/0/1'])(
  '[B1-01y §9.2] a database path like %s is refused without echoing the URL',
  (url) => {
    let error: unknown;
    try {
      ioredisOptions(url.replace('127.0.0.1', 'u:hidden-pw@127.0.0.1'), SETTINGS);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RedisValidationError);
    expect((error as Error).message.includes('hidden-pw')).toBe(false);
  },
);

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
  expect(clients[1]?.call).toHaveBeenCalledWith('GET', 'k');
  expect(clients[0]?.call).not.toHaveBeenCalled();
});

it('[B1-01y §10] a failed connect rejects with the socket error and drops the client', async () => {
  const { clients, driver } = fakeDriver();
  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const failing: DriverFactory = (options) => {
    const client = driver(options) as unknown as FakeClient;
    client.connect.mockImplementationOnce(async () => {
      client.emit('error', refused);
      throw new Error('Connection is closed.');
    });
    return client;
  };
  const transport = createIoredisTransport('redis://127.0.0.1:1/0', SETTINGS, failing);
  await expect(transport.connect()).rejects.toBe(refused);
  expect(clients[0]?.disconnect).toHaveBeenCalled();
  await expect(transport.call('GET', 'k')).rejects.toThrow('Redis connection is not open');
});

it('[B1-01y §9.2] only the end of the current connection is reported as lost', async () => {
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

it('[B1-01y §10] a real ioredis client from these options stays offline until connect()', () => {
  const client = new Redis(ioredisOptions('redis://127.0.0.1:1/0', SETTINGS));
  const errors: unknown[] = [];
  client.on('error', (error: unknown) => errors.push(error));
  expect(client.status).toBe('wait');
  client.disconnect();
  expect(client.status).not.toBe('connecting');
  expect(errors).toEqual([]);
});
