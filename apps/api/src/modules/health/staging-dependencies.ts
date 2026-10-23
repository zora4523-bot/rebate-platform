// Staging dependency probe for the worker and payout health checks (B1-01zzj).
// Called once per check by the inline `node -e` command in infra/staging/compose.yaml, which
// loads the built file apps/api/dist/modules/health/staging-dependencies.js and passes the
// container's own DATABASE_URL (and REDIS_URL for worker only).
//
// Rules for this file:
// - Runtime imports only `pg` and `ioredis`; no Nest, no config loader, no process globals.
//   The rule tests compile it in isolation with only those two drivers available.
// - Never fall back to a default role, database or Redis: a missing URL is unhealthy.
// - The connection string is handed to pg unchanged (credentials untouched). When it carries
//   sslmode, `uselibpqcompat=true` is appended so pg applies libpq semantics: verify-ca checks
//   the certificate chain against sslrootcert but not the host name (staging connects to
//   HAProxy by internal IP), instead of pg's default of treating verify-ca as verify-full.
// - Every step is time-bounded and every failure maps to `false`; nothing is logged, so no
//   connection string or driver message can leak into `docker inspect` health output.
import pg from 'pg';
import { Redis } from 'ioredis';

export interface StagingDependencyConfig {
  readonly databaseUrl: string;
  readonly redisUrl?: string;
}

/** Per-step bound (connect, query or PING, close): the three PG steps stay under the 5s Compose timeout. */
const STEP_TIMEOUT_MS = 1_500;

function present(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), STEP_TIMEOUT_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** The connection string for pg: unchanged, plus libpq TLS semantics when sslmode is set. */
export function pgConnectionString(databaseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null;
  if (url.hostname === '' || url.username === '') return null;
  if (!url.searchParams.has('sslmode') || url.searchParams.has('uselibpqcompat')) {
    return databaseUrl;
  }
  // Append textually so the rest of the string (user-info, password, other parameters)
  // stays byte-for-byte what the operator wrote.
  const hash = databaseUrl.indexOf('#');
  const head = hash < 0 ? databaseUrl : databaseUrl.slice(0, hash);
  const tail = hash < 0 ? '' : databaseUrl.slice(hash);
  return `${head}${head.includes('?') ? '&' : '?'}uselibpqcompat=true${tail}`;
}

async function probePostgres(connectionString: string): Promise<boolean> {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: STEP_TIMEOUT_MS,
    query_timeout: STEP_TIMEOUT_MS,
  });
  // An idle-client error after the probe must not crash the one-shot process.
  client.on('error', () => undefined);
  try {
    await withTimeout(client.connect(), 'PG connect');
    await withTimeout(client.query('SELECT 1'), 'PG query');
    return true;
  } catch {
    return false;
  } finally {
    await withTimeout(client.end(), 'PG end').catch(() => undefined);
  }
}

async function probeRedis(redisUrl: string): Promise<boolean> {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: STEP_TIMEOUT_MS,
    commandTimeout: STEP_TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);
  try {
    await withTimeout(redis.connect(), 'Redis connect');
    const reply = await withTimeout(redis.ping(), 'Redis PING');
    return reply === 'PONG';
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

/**
 * Compose's one-shot probe: PG query for both entries, Redis PING for worker only.
 * Return false on missing required URLs or dependency failure; never use a fallback role.
 * payout never reads or connects to Redis (ADR-0001 §4.2 #20), whatever the config holds.
 */
export async function checkStagingDependencies(
  entry: 'worker' | 'payout',
  config: StagingDependencyConfig,
): Promise<boolean> {
  try {
    if (entry !== 'worker' && entry !== 'payout') return false;
    const databaseUrl: unknown = config?.databaseUrl;
    if (!present(databaseUrl)) return false;
    const connectionString = pgConnectionString(databaseUrl);
    if (connectionString === null) return false;
    if (entry === 'payout') return await probePostgres(connectionString);
    const redisUrl: unknown = config.redisUrl;
    if (!present(redisUrl)) return false;
    const [database, redis] = await Promise.all([
      probePostgres(connectionString),
      probeRedis(redisUrl),
    ]);
    return database && redis;
  } catch {
    return false;
  }
}
