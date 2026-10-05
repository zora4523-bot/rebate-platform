// Redis handle of one process entry (ADR-0001 §2 cache row, §4.2 #17; B1-01y §9.2).
//
// This directory is also compiled by the erasable-only spec project: no Nest imports,
// decorators or non-erasable syntax. Use .ts relative imports and import type for types.
// Nest providers belong in platform.module.ts, which must call createRedisHandle through
// this redis/index.ts export (the wiring rules spy on this seam).
//
// Behaviour (rule tests: test/spec/platform/redis/**):
// - Lazy: createRedisHandle only builds the transport. The first command connects; a connection
//   that fails or exceeds connectTimeoutMs is disconnected, that command rejects with
//   RedisUnavailableError without being sent, and the next command tries a fresh connection.
//   Concurrent commands share one connection attempt.
// - Every write carries a TTL in whole seconds (SET key value EX ttl, one command); Lua scripts
//   get the TTL as ARGV[1] and must expire every key they write with it. Arguments are validated
//   before anything reaches Redis (RedisValidationError).
// - Keys are always `<namespace>:<key>`; namespaces are 1–64 of [a-z0-9_-].
// - No fallback, no retry, no replay: a failed or timed-out command rejects with
//   RedisUnavailableError and the caller decides (cache paths read PostgreSQL, risk paths reject).
//   A Redis error reply keeps the connection; any other failure or a timeout drops it, so the
//   next command reconnects.
// - close() / onApplicationShutdown(): idempotent; QUIT bounded by closeTimeoutMs, then a forced
//   disconnect. A handle that never connected closes without touching the network. Afterwards
//   every operation, also of namespaces obtained earlier, rejects with RedisClosedError.
// - Nothing inspectable holds the URL or the transport (closures only), errors never carry the
//   driver error (no `cause`; at most a validated code such as ECONNREFUSED or WRONGTYPE), and
//   log lines have flat fields only.
import type { ConnectionConfig } from '../db/index.ts';
import type { RootLogger } from '../logging/index.ts';
import { RedisClosedError, RedisUnavailableError, RedisValidationError } from './errors.ts';
import { createIoredisTransport } from './ioredis-transport.ts';
import type { RedisTransport } from './transport.ts';

export { RedisClosedError, RedisUnavailableError, RedisValidationError } from './errors.ts';
export type { RedisUnavailableReason } from './errors.ts';
export type { RedisTransport } from './transport.ts';

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

export interface RedisOptions {
  readonly logger: RootLogger;
  readonly connectTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly transportFactory?: (url: string) => RedisTransport;
}

/** Defaults of this module; each option may be an integer from 1 to 60 000 ms. */
export const REDIS_TIMEOUT_DEFAULTS = Object.freeze({
  connectTimeoutMs: 1_000,
  commandTimeoutMs: 1_000,
  closeTimeoutMs: 5_000,
});
const MAX_TIMEOUT_MS = 60_000;

/** Namespace rule of B1-01y §9.2; 64 is the minimum length the rules require. */
const NAMESPACE = /^[a-z0-9_-]{1,64}$/;
/** A Redis error prefix or a Node error code; anything else is dropped from errors and logs. */
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;

/** Rejection of withTimeout; never leaves this module. */
class TimeoutSignal extends Error {}

/** Settles with `run()`, or rejects with TimeoutSignal after `ms`; the timer never outlives it. */
function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutSignal());
    }, ms);
    let pending: Promise<T>;
    try {
      pending = Promise.resolve(run());
    } catch (error) {
      clearTimeout(timer);
      reject(error as Error);
      return;
    }
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

function timeoutOption(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new RedisValidationError(
      `${name} must be an integer from 1 to ${String(MAX_TIMEOUT_MS)}`,
    );
  }
  return value;
}

function validTtl(ttlSeconds: unknown): number {
  if (typeof ttlSeconds !== 'number' || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new RedisValidationError('ttlSeconds must be a positive integer number of seconds');
  }
  return ttlSeconds;
}

function validKey(key: unknown): string {
  if (typeof key !== 'string' || key === '') {
    throw new RedisValidationError('keys must be non-empty strings');
  }
  return key;
}

function validStrings(values: unknown, name: string): readonly string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new RedisValidationError(`${name} must be an array of strings`);
  }
  return values as readonly string[];
}

/** Password forms of the URL, to keep them out of codes even in contrived error messages. */
function secretsOf(href: string): string[] {
  try {
    const raw = new URL(href).password;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // Keep the raw form only.
    }
    return [raw, decoded].filter((secret) => secret !== '');
  } catch {
    return [];
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
export async function createRedisHandle(
  connection: Pick<ConnectionConfig, 'entry' | 'redisUrl'>,
  options: RedisOptions,
): Promise<RedisHandle | null> {
  const connectTimeoutMs = timeoutOption(
    options.connectTimeoutMs,
    REDIS_TIMEOUT_DEFAULTS.connectTimeoutMs,
    'connectTimeoutMs',
  );
  const commandTimeoutMs = timeoutOption(
    options.commandTimeoutMs,
    REDIS_TIMEOUT_DEFAULTS.commandTimeoutMs,
    'commandTimeoutMs',
  );
  const closeTimeoutMs = timeoutOption(
    options.closeTimeoutMs,
    REDIS_TIMEOUT_DEFAULTS.closeTimeoutMs,
    'closeTimeoutMs',
  );
  if (connection.redisUrl === null) return null;
  const href = connection.redisUrl.reveal();
  const factory =
    options.transportFactory ??
    ((url: string) =>
      createIoredisTransport(url, {
        connectionName: `couli-${connection.entry}`,
        connectTimeoutMs,
      }));
  const transport = factory(href);
  return buildHandle(transport, {
    logger: options.logger,
    secrets: secretsOf(href),
    connectTimeoutMs,
    commandTimeoutMs,
    closeTimeoutMs,
  });
}

interface HandleSettings {
  readonly logger: RootLogger;
  readonly secrets: readonly string[];
  readonly connectTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly closeTimeoutMs: number;
}

type State = 'idle' | 'connecting' | 'ready' | 'closed';

function buildHandle(transport: RedisTransport, settings: HandleSettings): RedisHandle {
  const { logger, secrets } = settings;
  let state: State = 'idle';
  /** Bumped by every established connection; a stale failure never resets a newer one. */
  let generation = 0;
  let connecting: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  /** Log only the first failure of a streak: a Redis outage must not flood the log. */
  let failing = false;
  /** The state as of now: other callbacks may change it while a function awaits. */
  const now = (): State => state;

  const safeCode = (error: unknown): string | null => {
    try {
      if (typeof error !== 'object' || error === null) return null;
      const code: unknown = Reflect.get(error, 'code');
      const message: unknown = Reflect.get(error, 'message');
      const candidate =
        typeof code === 'string'
          ? code
          : typeof message === 'string'
            ? /^\S+/.exec(message)?.[0]
            : undefined;
      if (candidate === undefined || !SAFE_CODE.test(candidate)) return null;
      if (secrets.some((secret) => secret.includes(candidate) || candidate.includes(secret))) {
        return null;
      }
      return candidate;
    } catch {
      return null;
    }
  };

  const disconnect = (): void => {
    try {
      transport.disconnect();
    } catch {
      // A local teardown; nothing left to do.
    }
  };

  /** Drops the connection of `seen` (if still current) so that the next command reconnects. */
  const reset = (seen: number): void => {
    if (state !== 'ready' || generation !== seen) return;
    state = 'idle';
    disconnect();
  };

  transport.onConnectionLost?.(() => {
    if (state !== 'ready') return;
    state = 'idle';
    logger.warn('redis_connection_lost');
  });

  const connectOnce = (): Promise<void> => {
    if (connecting !== null) return connecting;
    state = 'connecting';
    let attempt: Promise<void> | undefined = undefined;
    attempt = (async () => {
      // Run asynchronously, so that `connecting` is set before this attempt can settle.
      await Promise.resolve();
      try {
        await withTimeout(() => transport.connect(), settings.connectTimeoutMs);
      } catch (error) {
        disconnect();
        if (now() === 'closed') throw new RedisClosedError();
        state = 'idle';
        const reason = error instanceof TimeoutSignal ? 'connect_timeout' : 'connect_failed';
        const code = error instanceof TimeoutSignal ? null : safeCode(error);
        if (!failing) {
          failing = true;
          logger.warn({ reason, code }, 'redis_connect_failed');
        }
        throw new RedisUnavailableError(reason, code);
      } finally {
        if (connecting === attempt) connecting = null;
      }
      if (now() === 'closed') {
        // close() ran while connecting; it may have disconnected before the connection existed.
        disconnect();
        throw new RedisClosedError();
      }
      state = 'ready';
      generation += 1;
      if (failing) {
        failing = false;
        logger.info('redis_reconnected');
      }
    })();
    connecting = attempt;
    return attempt;
  };

  const ready = async (): Promise<number> => {
    if (state === 'closed') throw new RedisClosedError();
    if (state !== 'ready') await connectOnce();
    if (now() === 'closed') throw new RedisClosedError();
    if (now() !== 'ready') throw new RedisUnavailableError('connect_failed');
    return generation;
  };

  const run = async (command: string, args: (string | number)[]): Promise<unknown> => {
    const seen = await ready();
    try {
      return await withTimeout(() => transport.call(command, ...args), settings.commandTimeoutMs);
    } catch (error) {
      if (error instanceof TimeoutSignal) {
        // A connection that stops answering is not trusted with the next command.
        reset(seen);
        throw new RedisUnavailableError('command_timeout');
      }
      // An error reply leaves the connection usable; anything else may have broken it.
      if (!(error instanceof Error && error.name === 'ReplyError')) reset(seen);
      if (now() === 'closed') throw new RedisClosedError();
      throw new RedisUnavailableError('command_failed', safeCode(error));
    }
  };

  const open = (): void => {
    if (state === 'closed') throw new RedisClosedError();
  };

  const namespace = (name: string): RedisNamespace => {
    if (typeof name !== 'string' || !NAMESPACE.test(name)) {
      throw new RedisValidationError(
        'namespace must be 1 to 64 characters of lowercase letters, digits, "_" or "-"',
      );
    }
    open();
    const prefixed = (key: unknown): string => `${name}:${validKey(key)}`;
    return Object.freeze({
      async get(key: string): Promise<string | null> {
        const target = prefixed(key);
        open();
        const reply = await run('GET', [target]);
        if (reply === null || typeof reply === 'string') return reply;
        throw new RedisUnavailableError('unexpected_reply');
      },
      async set(key: string, value: string, ttlSeconds: number): Promise<void> {
        const target = prefixed(key);
        if (typeof value !== 'string') throw new RedisValidationError('value must be a string');
        const ttl = validTtl(ttlSeconds);
        open();
        const reply = await run('SET', [target, value, 'EX', String(ttl)]);
        if (reply !== 'OK') throw new RedisUnavailableError('unexpected_reply');
      },
      async eval(script: string, scriptOptions: RedisScriptOptions): Promise<unknown> {
        if (typeof script !== 'string' || script === '') {
          throw new RedisValidationError('script must be a non-empty string');
        }
        if (typeof scriptOptions !== 'object' || scriptOptions === null) {
          throw new RedisValidationError('script options must give keys, args and ttlSeconds');
        }
        const keys = validStrings(scriptOptions.keys, 'keys').map(prefixed);
        const args = validStrings(scriptOptions.args, 'args');
        const ttl = validTtl(scriptOptions.ttlSeconds);
        open();
        return await run('EVAL', [script, String(keys.length), ...keys, String(ttl), ...args]);
      },
    });
  };

  const close = (): Promise<void> => {
    if (closing !== null) return closing;
    const wasReady = state === 'ready';
    state = 'closed';
    closing = (async () => {
      if (!wasReady) {
        // Never connected, reset after a failure, or still connecting: a local teardown only
        // (no QUIT, which would make ioredis connect first).
        disconnect();
        return;
      }
      try {
        await withTimeout(() => transport.quit(), settings.closeTimeoutMs);
      } catch (error) {
        const timedOut = error instanceof TimeoutSignal;
        logger.warn(
          {
            reason: timedOut ? 'quit_timeout' : 'quit_failed',
            code: timedOut ? null : safeCode(error),
          },
          'redis_close_failed',
        );
        disconnect();
      }
    })();
    return closing;
  };

  return Object.freeze({
    namespace,
    close,
    onApplicationShutdown: close,
  });
}
