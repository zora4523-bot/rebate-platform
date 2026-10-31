// One-shot Redis for integration tests (ADR-0001 §4.2 #17; B1-01y §9.3). Test infrastructure
// only: never imported by application code. packages/db has no Redis driver, so readiness is a
// RESP PING over node:net.
//
// TEST_REDIS_URL (verify container and CI: redis:6379, noeviction, data on tmpfs) is shared by
// every test file of a run and stays in the worker environment: never log it or put it in an
// assertion message. Each acquireTestRedis() call leases a logical database of its own there
// (CT-06zzu): database 0 holds only the lease keys and database 13 belongs to
// test/spec/risk/redis-generation; neither is ever flushed by this file. The leased database is
// owned by this file for the lease's lifetime and is flushed when leased and again on stop()
// (only while the lease is still held: a lost lease's database may belong to someone else).
// Never FLUSHALL.
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';

/** Same image as infra/local/compose.yaml, CI and tools/ops/verify-container.sh. */
export const REDIS_TEST_IMAGE = 'redis:7.4.11-alpine';

const READY_TIMEOUT_MS = 60_000;
const PING_TIMEOUT_MS = 2_000;

export type TestRedis = {
  /**
   * redis:// URL of the database to use: the leased database of the shared TEST_REDIS_URL, or
   * database 0 of a Testcontainers container. May carry credentials: never log it.
   */
  url: string;
  source: 'env' | 'testcontainers';
  /**
   * Idempotent. Shared TEST_REDIS_URL: stops renewing and, while the lease is still held,
   * flushes the leased database and releases the lease. Testcontainers: stops the container.
   */
  stop(): Promise<void>;
};

function resp(args: readonly string[]): string {
  return `*${String(args.length)}\r\n${args
    .map((arg) => `$${String(Buffer.byteLength(arg))}\r\n${arg}\r\n`)
    .join('')}`;
}

/** Error code of a failed probe, without the URL (it may carry credentials). */
function probeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Redis probe failed: ${code}`), { code });
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** One AUTH (when the URL has credentials) + PING round trip; resolves on +PONG. */
function pingOnce(url: URL): Promise<void> {
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const port = url.port === '' ? 6379 : Number(url.port);
  const username = decoded(url.username);
  const password = decoded(url.password);
  const commands: string[][] = [];
  if (password !== '')
    commands.push(username === '' ? ['AUTH', password] : ['AUTH', username, password]);
  commands.push(['PING']);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const socket = connect({ host, port });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      finish(probeError('ETIMEDOUT'));
    }, PING_TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(commands.map(resp).join(''));
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (const line of buffer.split('\r\n').slice(0, -1)) {
        // An error reply (LOADING, NOAUTH, WRONGPASS…): its first word is the code.
        if (line.startsWith('-')) {
          finish(probeError(/^-(\S+)/.exec(line)?.[1] ?? 'ERR'));
          return;
        }
        if (line === '+PONG') {
          finish();
          return;
        }
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      finish(probeError(error.code ?? 'ESOCKET'));
    });
    socket.on('close', () => {
      finish(probeError('ECLOSED'));
    });
  });
}

/** Waits until the server at `value` answers PING. Errors never contain the URL. */
export async function waitForRedis(value: string, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The test Redis URL is not a valid URL');
  }
  if (url.protocol !== 'redis:') throw new Error('The test Redis URL must be a redis:// URL');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await pingOnce(url);
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        const code = (error as { code?: unknown }).code;
        throw new Error(
          `Redis did not become ready within ${String(timeoutMs)} ms` +
            (typeof code === 'string' ? ` (${code})` : ''),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

// --- Database leases on the shared TEST_REDIS_URL (CT-06zzu) ---------------------------------

/** An error reply (`-ERR …`) of one command; the other commands' replies are still returned. */
export class RedisErrorReply {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

export type RedisReply = string | number | null | RedisErrorReply | RedisReply[];

/**
 * Runs `commands` in order on one connection to the server of `url` (AUTH first when the URL has
 * credentials; the URL's database path is ignored, so the connection starts on database 0) and
 * resolves with one reply per command. Rejects without the URL in the message.
 */
export type RedisCommandRunner = (
  url: URL,
  commands: readonly (readonly string[])[],
) => Promise<RedisReply[]>;

/** Lease keys live in database 0, which is never flushed. */
export const LEASE_KEY_PREFIX = 'couli:test-redis-lease:';
/** Never leased: 0 holds the lease keys, 13 is test/spec/risk/redis-generation's own database. */
export const RESERVED_DATABASES: readonly number[] = [0, 13];
export const LEASE_TTL_MS = 120_000;
export const LEASE_RENEW_MS = 15_000;
export const LEASE_RETRY_MS = 250;
export const LEASE_WAIT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 10_000;

const RENEW_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then " +
  "return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
/**
 * One round trip for the whole lease: KEYS are the candidates' lease keys, ARGV[1] the token,
 * ARGV[2] the TTL and ARGV[2 + i] the database of KEYS[i]. Returns the first database whose
 * SET NX PX succeeded, or 0 when every candidate is leased.
 */
const LEASE_SCRIPT =
  'for i, key in ipairs(KEYS) do ' +
  "if redis.call('SET', key, ARGV[1], 'NX', 'PX', ARGV[2]) then return tonumber(ARGV[i + 2]) end " +
  'end return 0';
/**
 * Atomic check-and-flush: flushes database ARGV[2] only while KEYS[1] (the lease key, database 0)
 * still holds token ARGV[1]; returns 1 when flushed, 0 when the lease is no longer ours. SELECT
 * inside a script changes only the script's own database, and a failed SELECT aborts the script
 * before FLUSHDB, so FLUSHDB can never reach database 0.
 */
const FLUSH_SCRIPT =
  "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end " +
  "redis.call('SELECT', ARGV[2]) redis.call('FLUSHDB') return 1";

/**
 * Parses one RESP2 reply at `offset`; undefined while the buffer does not hold all of it yet.
 * Exported for unit tests.
 */
export function parseReply(
  buffer: Buffer,
  offset = 0,
): { reply: RedisReply; next: number } | undefined {
  const end = buffer.indexOf('\r\n', offset);
  if (end === -1) return undefined;
  const type = String.fromCharCode(buffer[offset] ?? 0);
  const line = buffer.toString('utf8', offset + 1, end);
  const next = end + 2;
  switch (type) {
    case '+':
      return { reply: line, next };
    case '-':
      return { reply: new RedisErrorReply(line), next };
    case ':':
      return { reply: Number(line), next };
    case '$': {
      const length = Number(line);
      if (length < 0) return { reply: null, next };
      if (buffer.length < next + length + 2) return undefined;
      return { reply: buffer.toString('utf8', next, next + length), next: next + length + 2 };
    }
    case '*': {
      const count = Number(line);
      if (count < 0) return { reply: null, next };
      const items: RedisReply[] = [];
      let at = next;
      for (let i = 0; i < count; i += 1) {
        const item = parseReply(buffer, at);
        if (item === undefined) return undefined;
        items.push(item.reply);
        at = item.next;
      }
      return { reply: items, next: at };
    }
    default:
      throw probeError('EPROTOCOL');
  }
}

/** The default RedisCommandRunner: one node:net connection, AUTH like pingOnce. */
export const runRedisCommands: RedisCommandRunner = (url, commands) => {
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const port = url.port === '' ? 6379 : Number(url.port);
  const username = decoded(url.username);
  const password = decoded(url.password);
  const auth: string[][] = [];
  if (password !== '')
    auth.push(username === '' ? ['AUTH', password] : ['AUTH', username, password]);
  const all = [...auth, ...commands];
  return new Promise<RedisReply[]>((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const replies: RedisReply[] = [];
    const socket = connect({ host, port });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error === undefined) resolve(replies.slice(auth.length));
      else reject(error);
    };
    const timer = setTimeout(() => {
      finish(probeError('ETIMEDOUT'));
    }, COMMAND_TIMEOUT_MS);
    socket.on('connect', () => {
      socket.write(all.map(resp).join(''));
    });
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        for (;;) {
          const parsed = parseReply(buffer);
          if (parsed === undefined) return;
          buffer = buffer.subarray(parsed.next);
          const reply = parsed.reply;
          // A failed AUTH: its first word is the code (NOAUTH, WRONGPASS…), never the URL.
          if (replies.length < auth.length && reply instanceof RedisErrorReply) {
            finish(probeError(/^(\S+)/.exec(reply.message)?.[1] ?? 'ERR'));
            return;
          }
          replies.push(reply);
          if (replies.length === all.length) {
            finish();
            return;
          }
        }
      } catch (error) {
        finish(error as Error);
      }
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      finish(probeError(error.code ?? 'ESOCKET'));
    });
    socket.on('close', () => {
      finish(probeError('ECLOSED'));
    });
  });
};

export type LeaseOptions = {
  run?: RedisCommandRunner;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  token?: () => string;
  waitMs?: number;
};

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function failed(what: string, error: unknown): Error {
  const code = codeOf(error);
  return new Error(
    `Test Redis ${what} failed` + (code === undefined ? '' : ` (${code})`),
    // The cause comes from the runner, whose messages never contain the URL.
    { cause: error },
  );
}

/** Connection-level failures worth retrying while waiting for a lease (auth errors are not). */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EADDRNOTAVAIL',
  'ETIMEDOUT',
  'ECLOSED',
  'EPIPE',
  'ESOCKET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'LOADING',
]);

/** Database count of the server (CONFIG GET databases), never hard-coded. */
function databaseCount(replies: RedisReply[]): number {
  const reply = replies[0];
  const count = Array.isArray(reply) && typeof reply[1] === 'string' ? Number(reply[1]) : NaN;
  if (!Number.isInteger(count) || count < 1)
    throw new Error('Test Redis CONFIG GET databases gave no database count');
  return count;
}

/**
 * Leases a database of its own on the shared Redis at `value` for one acquireTestRedis() call.
 * Exported (with injectable commands, clock and sleep) for unit tests.
 */
export async function leaseTestRedis(
  value: string,
  options: LeaseOptions = {},
): Promise<TestRedis> {
  const run = options.run ?? runRedisCommands;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const token = (options.token ?? (() => randomBytes(16).toString('hex')))();
  const waitMs = options.waitMs ?? LEASE_WAIT_MS;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The test Redis URL is not a valid URL');
  }

  // Connection errors and a full pool are both retried at LEASE_RETRY_MS until one deadline.
  const deadline = now() + waitMs;
  let candidates: number[] | undefined;
  let leased = 0;
  for (;;) {
    let lastCode: string | undefined;
    try {
      if (candidates === undefined) {
        const count = databaseCount(await run(url, [['CONFIG', 'GET', 'databases']]));
        candidates = [];
        for (let n = 1; n < count; n += 1) if (!RESERVED_DATABASES.includes(n)) candidates.push(n);
        if (candidates.length === 0)
          throw new Error(`Test Redis has ${String(count)} databases: none can be leased`);
      }
      const [reply] = await run(url, [
        [
          'EVAL',
          LEASE_SCRIPT,
          String(candidates.length),
          ...candidates.map((n) => LEASE_KEY_PREFIX + String(n)),
          token,
          String(LEASE_TTL_MS),
          ...candidates.map(String),
        ],
      ]);
      if (reply instanceof RedisErrorReply)
        throw new Error(`Test Redis lease was refused: ${reply.message}`);
      if (typeof reply === 'number' && reply > 0) {
        leased = reply;
        break;
      }
    } catch (error) {
      lastCode = codeOf(error);
      if (lastCode === undefined || !RETRYABLE_CODES.has(lastCode)) {
        if (lastCode === undefined) throw error;
        throw failed('lease', error);
      }
    }
    if (now() >= deadline) {
      if (lastCode !== undefined)
        throw new Error(
          `Test Redis lease failed: the connection kept failing for ${String(waitMs)} ms (${lastCode})`,
        );
      throw new Error(
        `All ${String(candidates?.length ?? 0)} leasable test Redis databases stayed leased for ` +
          `${String(waitMs)} ms (databases 0 and 13 are never leased); too many test files ` +
          'hold a test Redis at once, or leases of crashed runs have not expired yet',
      );
    }
    await sleep(LEASE_RETRY_MS);
  }
  const db = leased;
  const key = LEASE_KEY_PREFIX + String(db);
  const release = async (): Promise<void> => {
    try {
      await run(url, [['EVAL', RELEASE_SCRIPT, '1', key, token]]);
    } catch (error) {
      throw failed('lease release', error);
    }
  };
  /** True when flushed, false when the lease no longer holds our token (nothing flushed). */
  const flushIfHeld = async (): Promise<boolean> => {
    let replies: RedisReply[];
    try {
      replies = await run(url, [['EVAL', FLUSH_SCRIPT, '1', key, token, String(db)]]);
    } catch (error) {
      throw failed('FLUSHDB of the leased database', error);
    }
    const [reply] = replies;
    if (reply === 1) return true;
    if (reply === 0) return false;
    const detail = reply instanceof RedisErrorReply ? `: ${reply.message}` : '';
    throw new Error(`Test Redis FLUSHDB of the leased database failed${detail}`);
  };

  let flushed: boolean;
  try {
    flushed = await flushIfHeld();
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
  if (!flushed) throw new Error('Test Redis lease was lost right after it was taken');

  // Renewal compares the token, so a lease that expired and went to someone else stays theirs;
  // a 0 answer (other token or no key) marks this lease lost: renewing stops and stop() then
  // neither flushes the database nor deletes the key. A failed round trip is retried next time.
  // unref: a forgotten stop() never keeps the worker alive; the lease then simply expires.
  let lost = false;
  const renewal = setInterval(() => {
    run(url, [['EVAL', RENEW_SCRIPT, '1', key, token, String(LEASE_TTL_MS)]]).then(
      (replies) => {
        if (replies[0] === 0) {
          lost = true;
          clearInterval(renewal);
        }
      },
      () => undefined,
    );
  }, LEASE_RENEW_MS);
  renewal.unref();

  const leasedUrl = new URL(url.href);
  leasedUrl.pathname = `/${String(db)}`;
  let stopped: Promise<void> | undefined;
  return {
    url: leasedUrl.href,
    source: 'env',
    stop: async () => {
      stopped ??= (async () => {
        clearInterval(renewal);
        if (lost) return;
        // The token check and FLUSHDB run in one script: a lease that went to someone else is
        // never flushed, and only a lease that is still ours is released.
        let held = true;
        try {
          held = await flushIfHeld();
        } finally {
          if (held) await release();
          else lost = true;
        }
      })();
      await stopped;
    },
  };
}

async function startContainer<T>(start: () => Promise<T>): Promise<T> {
  try {
    return await start();
  } catch (error) {
    throw new Error(
      'Could not start a Redis container. Redis integration tests need either Docker ' +
        '(Testcontainers) or TEST_REDIS_URL pointing at a one-shot Redis (B1-01y §9.3).',
      { cause: error },
    );
  }
}

/**
 * Single entry point to the one-shot test Redis, like acquireAdminPg: TEST_REDIS_URL when set
 * (verify container, CI service), otherwise a Testcontainers container on the host with
 * `maxmemory-policy noeviction` (ADR-0001 §4.2 #17) and no persistence.
 */
export async function acquireTestRedis(): Promise<TestRedis> {
  const fromEnv = process.env['TEST_REDIS_URL'];
  if (fromEnv !== undefined && fromEnv !== '') {
    await waitForRedis(fromEnv);
    return leaseTestRedis(fromEnv);
  }

  const { GenericContainer, Wait } = await import('testcontainers');
  const container = await startContainer(() =>
    new GenericContainer(REDIS_TEST_IMAGE)
      .withExposedPorts(6379)
      // Throwaway data: memory only, no RDB snapshots, no AOF.
      .withTmpFs({ '/data': 'rw' })
      .withCommand([
        'redis-server',
        '--save',
        '',
        '--appendonly',
        'no',
        '--maxmemory',
        '256mb',
        '--maxmemory-policy',
        'noeviction',
      ])
      .withLabels({ 'couli.purpose': 'one-shot-test-redis' })
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .withStartupTimeout(120_000)
      .start(),
  );
  const host = container.getHost();
  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const url = `redis://${hostPart}:${String(container.getMappedPort(6379))}/0`;
  try {
    await waitForRedis(url);
  } catch (error) {
    await container.stop();
    throw error;
  }
  let stopped: Promise<void> | undefined;
  return {
    url,
    source: 'testcontainers',
    stop: async () => {
      stopped ??= container.stop().then(() => undefined);
      await stopped;
    },
  };
}
