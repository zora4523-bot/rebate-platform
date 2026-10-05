// Production RedisTransport on ioredis (ADR-0001 §2: Redis 7.x + ioredis 5.11.x).
//
// - One fresh ioredis client per connect(): a client that failed, timed out or was dropped is
//   never reused, so its internal state ("already connecting", a pending reconnect) cannot leak
//   into the next attempt. Clients are created only inside connect(): building the transport
//   opens nothing.
// - Driver behaviour that would contradict the handle is switched off: no automatic reconnect,
//   no offline queue, no resend of unfulfilled commands, no per-request retries. Failures reach
//   the handle as rejections and the handle decides.
// - Every client has an 'error' listener for its whole life: ioredis otherwise prints
//   "Unhandled error event" through console. The listener only remembers the error, so that a
//   failed connect() rejects with the socket error (ECONNREFUSED, …) instead of the generic
//   "Connection is closed."; it logs nothing (the handle logs flat fields only).
// - Only scheme, host, port, user, password and the database path of REDIS_URL are used. Its
//   query string is not interpreted: ioredis would merge query values into the options with
//   priority over the settings above.
import { Redis, type RedisOptions as DriverOptions } from 'ioredis';
import { RedisValidationError } from './errors.ts';
import type { RedisTransport } from './transport.ts';

export interface IoredisSettings {
  /** CLIENT SETNAME of every connection (`couli-<entry>`), visible in CLIENT LIST. */
  readonly connectionName: string;
  readonly connectTimeoutMs: number;
}

/** The part of an ioredis client this transport uses (tests pass a stand-in). */
export interface DriverClient {
  readonly status: string;
  connect(): Promise<void>;
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): void;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
}

export type DriverFactory = (options: DriverOptions) => DriverClient;

const defaultDriver: DriverFactory = (options) => new Redis(options) as unknown as DriverClient;

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RedisValidationError('REDIS_URL user and password must be valid percent-encoding');
  }
}

function databaseIndex(pathname: string): number {
  if (pathname === '' || pathname === '/') return 0;
  const match = /^\/(0|[1-9][0-9]{0,4})$/.exec(pathname);
  if (match === null) {
    throw new RedisValidationError('REDIS_URL path must be empty or a database number');
  }
  return Number(match[1]);
}

/** ioredis options for `href` (a REDIS_URL validated by loadConnectionConfig). */
export function ioredisOptions(href: string, settings: IoredisSettings): DriverOptions {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    // Never pass URL's TypeError on: it carries the input, credentials included.
    throw new RedisValidationError('REDIS_URL must be a redis:// or rediss:// URL');
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new RedisValidationError('REDIS_URL must be a redis:// or rediss:// URL');
  }
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (host === '') throw new RedisValidationError('REDIS_URL must name a host');
  const username = decoded(url.username);
  const password = decoded(url.password);
  return {
    host,
    port: url.port === '' ? 6379 : Number(url.port),
    db: databaseIndex(url.pathname),
    ...(username === '' ? {} : { username }),
    ...(password === '' ? {} : { password }),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    connectionName: settings.connectionName,
    connectTimeout: settings.connectTimeoutMs,
    lazyConnect: true,
    enableReadyCheck: true,
    enableOfflineQueue: false,
    enableAutoPipelining: false,
    autoResendUnfulfilledCommands: false,
    autoResubscribe: false,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    reconnectOnError: () => false,
    disableClientInfo: true,
  };
}

/** Creates the transport; validates `href` now, connects only in connect(). */
export function createIoredisTransport(
  href: string,
  settings: IoredisSettings,
  driver: DriverFactory = defaultDriver,
): RedisTransport {
  const options = ioredisOptions(href, settings);
  /** The client commands go to; null before the first connect and after a drop. */
  let current: DriverClient | null = null;
  /** Clients that were not disconnected yet (current, or one sending QUIT). */
  const live = new Set<DriverClient>();
  let lost: (() => void) | null = null;

  const drop = (client: DriverClient): void => {
    live.delete(client);
    if (current === client) current = null;
    try {
      client.disconnect();
    } catch {
      // Local teardown only.
    }
  };

  return Object.freeze({
    async connect(): Promise<void> {
      if (current !== null) drop(current);
      const client = driver(options);
      let lastError: unknown;
      client.on('error', (error: unknown) => {
        lastError = error;
      });
      client.on('end', () => {
        live.delete(client);
        if (current !== client) return;
        current = null;
        lost?.();
      });
      current = client;
      live.add(client);
      try {
        await client.connect();
      } catch (error) {
        drop(client);
        throw lastError ?? error;
      }
      if (current !== client) {
        // disconnect() ran while the handshake finished: do not keep this connection.
        drop(client);
        throw new Error('Redis connection was closed while connecting');
      }
    },
    call(command: string, ...args: (string | number)[]): Promise<unknown> {
      if (current === null) return Promise.reject(new Error('Redis connection is not open'));
      return current.call(command, ...args);
    },
    async quit(): Promise<unknown> {
      const client = current;
      if (client === null) return undefined;
      current = null;
      if (client.status !== 'ready') {
        drop(client);
        return undefined;
      }
      try {
        return await client.quit();
      } finally {
        live.delete(client);
      }
    },
    disconnect(): void {
      current = null;
      for (const client of [...live]) drop(client);
    },
    onConnectionLost(listener: () => void): void {
      lost = listener;
    },
  });
}
