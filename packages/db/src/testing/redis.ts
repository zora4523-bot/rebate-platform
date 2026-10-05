// One-shot Redis for integration tests (ADR-0001 §4.2 #17; B1-01y §9.3). Test infrastructure
// only: never imported by application code. packages/db has no Redis driver, so readiness is a
// RESP PING over node:net.
//
// TEST_REDIS_URL (verify container and CI: redis:6379, noeviction, data on tmpfs) is shared by
// every test file of a run and stays in the worker environment: never log it or put it in an
// assertion message, and keep each file's keys under its own namespace (no FLUSHDB/FLUSHALL).
import { connect } from 'node:net';

/** Same image as infra/local/compose.yaml, CI and tools/ops/verify-container.sh. */
export const REDIS_TEST_IMAGE = 'redis:7.4.11-alpine';

const READY_TIMEOUT_MS = 60_000;
const PING_TIMEOUT_MS = 2_000;

export type TestRedis = {
  /** redis:// URL of database 0. May carry credentials: never log it. */
  url: string;
  source: 'env' | 'testcontainers';
  /** Stops a Testcontainers container (idempotent); a no-op for the shared TEST_REDIS_URL. */
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
    return { url: fromEnv, source: 'env', stop: async () => {} };
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
