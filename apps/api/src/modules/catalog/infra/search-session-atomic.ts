// B1-05g ①: search sessions written by compare-and-swap, so two application instances continuing
// the same session concurrently never drop each other's issued keys (BR-PROD-08 ②). A write reads
// the stored value, merges the caller's session into it and swaps only if the stored text is still
// the one it read; on a conflict it re-reads and merges again, a bounded number of times.
// Merge: the union of issued keys, each with the earliest page that issued it; at most 500 keys
// (beyond that deduplication stops for good: a late writer cannot switch it back on); the latest
// touchedAtMs. A stored value of another app, requester or query (or unreadable) is replaced.
import type { SearchSession, SearchSessionStore } from '../search.ts';
import type { RedisNamespace } from '../../platform/index.ts';
import { CatalogError } from '../domain/rules.ts';

/** Opaque storage primitive: Redis implements compareAndSwap in one expiring Lua command.
 * This port contains no seen-set merge, page provenance, or dedup policy.
 */
export interface AtomicSessionStorage {
  read(key: string): Promise<string | null>;
  compareAndSwap(
    key: string,
    expected: string | null,
    replacement: string,
    ttlSeconds: number,
  ): Promise<boolean>;
}

/** BR-PROD-08 ②: at most 500 issued product keys per session (same value as search.ts). */
const SEEN_LIMIT = 500;
/** Conflicting writers re-read and merge at most this many times before failing as a dependency. */
const MAX_ATTEMPTS = 16;

export function sessionKey(appId: string, sessionId: string): string {
  return `${appId}:session:${sessionId}`;
}

function isSession(value: unknown): value is SearchSession {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['appId'] === 'string' &&
    typeof record['requester'] === 'string' &&
    typeof record['query'] === 'object' &&
    record['query'] !== null &&
    typeof record['touchedAtMs'] === 'number' &&
    Array.isArray(record['seen']) &&
    record['seen'].every((key) => typeof key === 'string') &&
    (record['seenPages'] === undefined ||
      (Array.isArray(record['seenPages']) &&
        record['seenPages'].every((page) => typeof page === 'number'))) &&
    typeof record['dedupDisabled'] === 'boolean'
  );
}

export function parseSession(text: string | null): SearchSession | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isSession(value) ? value : null;
  } catch {
    return null;
  }
}

/** Canonical (sorted-key) JSON of a session query, for the same-query comparison. */
function queryText(query: SearchSession['query']): string {
  const record = query as unknown as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(record)
      .sort()
      .map((name) => [name, record[name]]),
  );
}

function sameOwner(a: SearchSession, b: SearchSession): boolean {
  return (
    a.appId === b.appId && a.requester === b.requester && queryText(a.query) === queryText(b.query)
  );
}

/** Pages parallel to seen; a session without seenPages counts every key as issued by page 0. */
function pagesOf(session: SearchSession): number[] {
  return session.seen.map((_key, index) => session.seenPages?.[index] ?? 0);
}

/** The stored session with the caller's increments merged in (see the header). */
function merge(stored: SearchSession, incoming: SearchSession): SearchSession {
  const seen: string[] = [];
  const seenPages: number[] = [];
  const at = new Map<string, number>();
  let overflow = false;
  const add = (keys: readonly string[], pages: readonly number[]): void => {
    keys.forEach((key, index) => {
      const page = pages[index]!;
      const existing = at.get(key);
      if (existing !== undefined) {
        if (page < seenPages[existing]!) seenPages[existing] = page;
        return;
      }
      if (seen.length >= SEEN_LIMIT) {
        overflow = true;
        return;
      }
      at.set(key, seen.length);
      seen.push(key);
      seenPages.push(page);
    });
  };
  add(stored.seen, pagesOf(stored));
  add(incoming.seen, pagesOf(incoming));
  return {
    ...incoming,
    touchedAtMs: Math.max(stored.touchedAtMs, incoming.touchedAtMs),
    seen,
    seenPages,
    dedupDisabled: stored.dedupDisabled || incoming.dedupDisabled || overflow,
  };
}

export function createAtomicSearchSessionStore(storage: AtomicSessionStorage): SearchSessionStore {
  return {
    async read(appId, sessionId) {
      const session = parseSession(await storage.read(sessionKey(appId, sessionId)));
      // A value stored under this app's key always names this app; anything else is no session.
      return session !== null && session.appId === appId ? session : null;
    },
    async write(appId, sessionId, session, ttlSeconds) {
      const key = sessionKey(appId, sessionId);
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const text = await storage.read(key);
        const stored = parseSession(text);
        const next =
          stored !== null && sameOwner(stored, session) ? merge(stored, session) : session;
        if (await storage.compareAndSwap(key, text, JSON.stringify(next), ttlSeconds)) return;
      }
      // Persistent contention: a dependency failure of the search, never a silent lost update.
      throw new CatalogError(50304, 'search: session write kept conflicting', {
        platform: session.query.platform,
      });
    },
  };
}

/**
 * Compare-and-swap in one Lua command. The namespace passes the TTL as ARGV[1]; ARGV[2] is the
 * expected value ('' for "absent") and ARGV[3] the replacement. Returns 1 when written, else 0.
 */
const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if ARGV[2] == '' then
  if current then return 0 end
elseif current ~= ARGV[2] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[3], 'EX', tonumber(ARGV[1]))
return 1
`;

/** Redis CAS protocol: one key, args [expected JSON or empty for absent, replacement JSON].
 * The Lua command returns 1 for a write and 0 for a conflict; ttlSeconds expires that write.
 */
export function createRedisAtomicSessionStorage(redis: RedisNamespace): AtomicSessionStorage {
  return {
    read: (key) => redis.get(key),
    async compareAndSwap(key, expected, replacement, ttlSeconds) {
      const reply = await redis.eval(CAS_SCRIPT, {
        keys: [key],
        args: [expected ?? '', replacement],
        ttlSeconds,
      });
      return reply === 1 || reply === '1';
    },
  };
}
