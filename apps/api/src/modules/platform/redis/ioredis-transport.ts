// Production RedisTransport on ioredis (ADR-0001 §2: Redis 7.x + ioredis 5.11.x).
//
// - One fresh ioredis client per connect(): a client that failed, timed out or was dropped is
//   never reused, so its internal state ("already connecting", a pending reconnect) cannot leak
//   into the next attempt. Clients are created only inside connect(): building the transport
//   opens nothing.
// - Driver behaviour that would contradict the handle is switched off: no automatic reconnect,
//   no offline queue, no resend of unfulfilled commands, no per-request retries, no built-in
//   ready check (its INFO prints a console warning when the ACL denies INFO). Failures reach the
//   handle as rejections and the handle decides.
// - connect() owns the handshake after the driver is up, bounded by connectTimeoutMs as a whole:
//   SELECT <db> when REDIS_URL names a database other than 0 (ioredis itself would only emit an
//   'error' event on a refused SELECT and carry on in db 0), then PING as the ready check (a
//   server still loading answers LOADING). Any 'error' event during the handshake fails it too.
//   A failed handshake disconnects that client and rejects; nothing else is sent on it.
// - Every client has an 'error' listener for its whole life: ioredis otherwise prints
//   "Unhandled error event" through console. The listener only remembers the first error of the
//   handshake, so that a failed connect() rejects with the socket error (ECONNREFUSED, …) instead
//   of the generic "Connection is closed."; it logs nothing (the handle logs flat fields only).
// - A client is tracked until it is disconnected: a QUIT that is refused, fails or hangs still
//   ends in a forced disconnect of that client, so no TCP connection is left open.
// - Only scheme, host, port, user, password and the database path of REDIS_URL are used. A query
//   string is refused (RedisValidationError) rather than silently ignored.
//
// Deployment requirements (ops):
// - The ACL user of REDIS_URL must be allowed PING, and SELECT when REDIS_URL names a database
//   other than 0; without them every connection attempt fails (RedisUnavailableError).
// - Give REDIS_URL a password only when the server requires one: ioredis prints a console warning
//   when AUTH reaches a server without a password.
// - Never enable `DEBUG=ioredis:*` in production: ioredis then writes every command with its
//   arguments to stderr, AUTH (the password) included.
// - REDIS_URL must not have a query string. loadConnectionConfig lets one through, but creating
//   the handle refuses it (RedisValidationError), so that entry fails at startup.
import { Redis, type RedisOptions as DriverOptions } from 'ioredis';
import { RedisValidationError } from './errors.ts';
import type { RedisTransport } from './transport.ts';

export interface IoredisSettings {
  /** CLIENT SETNAME of every connection (`couli-<entry>`), visible in CLIENT LIST. */
  readonly connectionName: string;
  /** Bounds the whole connect(): TCP connect, AUTH, SELECT and the PING ready check. */
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

/**
 * How to reach REDIS_URL: driver options, and the database connect() selects itself.
 *
 * ioredis's own record of the database stays at 0: it never sees `db`, and it only tracks a
 * lowercase `select` command, not the SELECT that connect() sends through call(). Nothing may
 * rely on that record. Should retryStrategy or autoResendUnfulfilledCommands ever be turned on,
 * a driver-level reconnect would follow that record (no SELECT) and silently land in db 0.
 */
export interface IoredisPlan {
  /** Never carries `db`: SELECT is part of connect()'s own handshake. */
  readonly options: DriverOptions;
  readonly database: number;
}

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

/** Connection plan for `href` (a REDIS_URL validated by loadConnectionConfig). */
export function ioredisPlan(href: string, settings: IoredisSettings): IoredisPlan {
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
  if (url.search !== '') {
    throw new RedisValidationError('REDIS_URL must not have a query string');
  }
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (host === '') throw new RedisValidationError('REDIS_URL must name a host');
  const username = decoded(url.username);
  const password = decoded(url.password);
  const database = databaseIndex(url.pathname);
  return {
    database,
    options: {
      host,
      port: url.port === '' ? 6379 : Number(url.port),
      ...(username === '' ? {} : { username }),
      ...(password === '' ? {} : { password }),
      ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
      connectionName: settings.connectionName,
      connectTimeout: settings.connectTimeoutMs,
      lazyConnect: true,
      enableReadyCheck: false,
      enableOfflineQueue: false,
      enableAutoPipelining: false,
      autoResendUnfulfilledCommands: false,
      autoResubscribe: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      reconnectOnError: () => false,
      disableClientInfo: true,
    },
  };
}

/** Settles with `pending`, or rejects with ETIMEDOUT after `ms`; the timer never outlives it. */
function bounded<T>(pending: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error('Redis handshake timed out'), { code: 'ETIMEDOUT' }));
    }, ms);
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

/** Creates the transport; validates `href` now, connects only in connect(). */
export function createIoredisTransport(
  href: string,
  settings: IoredisSettings,
  driver: DriverFactory = defaultDriver,
): RedisTransport {
  const { options, database } = ioredisPlan(href, settings);
  /** The client commands go to; null before the first connect and after a drop. */
  let current: DriverClient | null = null;
  /** Clients that were not disconnected yet (current, or one sending QUIT). */
  const live = new Set<DriverClient>();
  let lost: (() => void) | null = null;

  /** Forces `client` shut and stops tracking it; a no-op for a client already ended or dropped. */
  const drop = (client: DriverClient): void => {
    if (current === client) current = null;
    if (!live.delete(client)) return;
    try {
      client.disconnect();
    } catch {
      // Local teardown only.
    }
  };

  /** SELECT (if any) and the PING ready check, sent on `client` itself, never through call(). */
  const handshake = async (client: DriverClient): Promise<void> => {
    await client.connect();
    if (database !== 0) {
      const selected = await client.call('SELECT', database);
      if (selected !== 'OK') throw new Error('Redis SELECT was not confirmed');
    }
    const pong = await client.call('PING');
    if (pong !== 'PONG') throw new Error('Redis ready check got an unexpected reply');
  };

  return Object.freeze({
    async connect(): Promise<void> {
      if (current !== null) drop(current);
      const client = driver(options);
      let handshaking = true;
      let established = false;
      /** The first 'error' event while handshaking; it fails the handshake. */
      let handshakeError: unknown;
      client.on('error', (error: unknown) => {
        if (handshaking && handshakeError === undefined) handshakeError = error;
      });
      client.on('end', () => {
        // Ended means the socket is closed: nothing left to disconnect.
        live.delete(client);
        if (current !== client) return;
        current = null;
        if (established) lost?.();
      });
      current = client;
      live.add(client);
      try {
        await bounded(handshake(client), settings.connectTimeoutMs);
        if (handshakeError !== undefined) throw handshakeError;
        if (current !== client) {
          // disconnect() ran while the handshake finished: do not keep this connection.
          throw new Error('Redis connection was closed while connecting');
        }
      } catch (error) {
        drop(client);
        throw handshakeError ?? error;
      } finally {
        handshaking = false;
      }
      established = true;
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
      // Tracked until QUIT settles: a QUIT that hangs is ended by disconnect().
      try {
        return await client.quit();
      } finally {
        // After a refused or failed QUIT the socket may still be open: force it shut. After a
        // successful QUIT the server closes it anyway; this only ends our side early.
        drop(client);
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
