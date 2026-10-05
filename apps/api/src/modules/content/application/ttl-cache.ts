import type { Clock } from '../../platform/index.ts';
import { isFresh } from '../domain/cache-policy.ts';

interface Entry<V> {
  readonly value: V;
  readonly loadedAtMs: number;
}

/**
 * Per-key cache whose entries live for a fixed time measured on the injected Clock.
 *
 * - A hit never extends an entry's lifetime; only a successful load (re)starts it. The entry is
 *   stamped with the instant its load started, so it is never served longer than the TTL after
 *   the read that produced it.
 * - An expired entry is never served: it is dropped as soon as a read finds it expired. A failed
 *   load rejects every caller waiting on it, stores nothing and renews nothing, so the next call
 *   loads again at once.
 * - Concurrent misses of one key share a single load.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly loads = new Map<string, Promise<V>>();
  // Plain fields, not parameter properties: rule tests compile this file with erasable syntax only.
  private readonly clock: Clock;
  private readonly ttlMs: number;

  constructor(clock: Clock, ttlMs: number) {
    this.clock = clock;
    this.ttlMs = ttlMs;
  }

  get(key: string, load: () => Promise<V>): Promise<V> {
    const startedAtMs = this.clock.now().getTime();
    const entry = this.entries.get(key);
    if (entry !== undefined) {
      if (isFresh(entry.loadedAtMs, startedAtMs, this.ttlMs)) return Promise.resolve(entry.value);
      // Once judged expired the entry is gone for good: if the reload fails and the clock then
      // steps back into its lifetime, it must not be served again.
      this.entries.delete(key);
    }
    const pending = this.loads.get(key);
    if (pending !== undefined) return pending;
    // `load` runs in a later microtask, after the pending load is registered below, so even a
    // synchronous throw goes through `finally` and never leaves a settled load registered.
    const loading = Promise.resolve()
      .then(load)
      .then((value) => {
        this.entries.set(key, { value, loadedAtMs: startedAtMs });
        return value;
      })
      .finally(() => {
        this.loads.delete(key);
      });
    this.loads.set(key, loading);
    return loading;
  }
}
