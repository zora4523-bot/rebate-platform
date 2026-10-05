// This directory is also compiled by the erasable-only spec project: no Nest imports,
// decorators or non-erasable syntax. Use .ts relative imports and import type for types.
// Nest providers belong in platform.module.ts, which must call createRedisHandle through
// this redis/index.ts export (the wiring rules spy on this seam).
import type { ConnectionConfig } from '../db/index.ts';
import type { RootLogger } from '../logging/index.ts';

/** B1-01y §9.2: seconds, validated before any Redis command. */
export interface RedisScriptOptions {
  readonly keys: readonly string[];
  readonly args: readonly string[];
  /** Passed as ARGV[1]; caller arguments start at ARGV[2]. */
  readonly ttlSeconds: number;
}

/** Trusted application scripts must expire every key they write using ARGV[1]. */
export interface RedisNamespace {
  get(key: string): Promise<string | null>;
  /** One atomic SET with expiry; never SET followed by EXPIRE. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  eval(script: string, options: RedisScriptOptions): Promise<unknown>;
}

/** Keep transport and URL only in closures or #private fields, never inspectable properties. */
export interface RedisHandle {
  /** Lowercase letters, digits, _ and -; any length limit must allow at least 64 characters. */
  namespace(name: string): RedisNamespace;
  /** Idempotent; invalidates previously acquired namespaces as well. */
  close(): Promise<void>;
  onApplicationShutdown(): Promise<void>;
}

/**
 * Internal driver seam: production uses ioredis; rules inject a network-free transport.
 * Readiness checks belong inside connect(); the handle uses call() only for user commands,
 * never for an extra handshake or PING.
 */
export interface RedisTransport {
  connect(): Promise<void>;
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export interface RedisOptions {
  readonly logger: RootLogger;
  readonly connectTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly transportFactory?: (url: string) => RedisTransport;
}

export class RedisValidationError extends Error {
  constructor() {
    super();
    throw new Error('NotImplemented: RedisValidationError');
  }
}

export class RedisUnavailableError extends Error {
  constructor() {
    super();
    throw new Error('NotImplemented: RedisUnavailableError');
  }
}

export class RedisClosedError extends RedisUnavailableError {
  constructor() {
    super();
    throw new Error('NotImplemented: RedisClosedError');
  }
}

/**
 * One handle per entry, null for payout (existing ConnectionConfig.redisUrl is null).
 * Only create the transport here; connect lazily before the first command. On connection
 * failure/timeout, disconnect and reject that command with a sanitized RedisUnavailableError
 * without sending it; the next command must attempt a fresh connection.
 * No operation is silently replayed. Timeout options bound connect, command and graceful quit.
 * Bootstrap accepts redisUrl: ConnectionConfig['redisUrl']; Nest exports the REDIS token from
 * platform/index.ts when a URL is supplied, and closes the handle on application shutdown.
 */
export function createRedisHandle(
  connection: Pick<ConnectionConfig, 'entry' | 'redisUrl'>,
  options: RedisOptions,
): Promise<RedisHandle | null> {
  void connection;
  void options;
  throw new Error('NotImplemented: createRedisHandle');
}
