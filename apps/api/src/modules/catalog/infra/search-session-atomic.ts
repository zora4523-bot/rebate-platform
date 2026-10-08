import type { SearchSessionStore } from '../search.ts';
import type { RedisNamespace } from '../../platform/index.ts';

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

export function createAtomicSearchSessionStore(storage: AtomicSessionStorage): SearchSessionStore {
  void storage;
  throw new Error('NotImplemented: createAtomicSearchSessionStore');
}

/** Redis CAS protocol: one key, args [expected JSON or empty for absent, replacement JSON].
 * The Lua command returns 1 for a write and 0 for a conflict; ttlSeconds expires that write.
 */
export function createRedisAtomicSessionStorage(redis: RedisNamespace): AtomicSessionStorage {
  void redis;
  throw new Error('NotImplemented: createRedisAtomicSessionStorage');
}
