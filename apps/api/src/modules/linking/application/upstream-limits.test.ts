import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import { BIND_RETRY_AFTER_SEC, createBoundedQueue } from './upstream-limits.ts';

describe('createBoundedQueue (B1-06za)', () => {
  it('[AC-B1-06za] a waiter runs in its own async context, not in the releasing caller’s', async () => {
    const store = new AsyncLocalStorage<string>();
    const gate = createBoundedQueue({ concurrency: 1, queueCapacity: 1, waitMs: 2000 });
    const release = Promise.withResolvers<void>();
    const seen: (string | undefined)[] = [];
    const first = store.run('holder', () =>
      gate.run(async () => {
        await release.promise;
        seen.push(store.getStore());
      }),
    );
    const second = store.run('waiter', () =>
      gate.run(async () => {
        seen.push(store.getStore());
        return 'done';
      }),
    );
    expect(gate.waiting).toBe(1);
    release.resolve();
    await first;
    expect(await second).toEqual({ kind: 'completed', value: 'done' });
    expect(seen).toEqual(['holder', 'waiter']);
  }, 5_000);

  it('[AC-B1-06za] rejects limits that are not positive integers', () => {
    expect(() => createBoundedQueue({ concurrency: 0, queueCapacity: 1, waitMs: 1 })).toThrow(
      RangeError,
    );
    expect(() => createBoundedQueue({ concurrency: 1, queueCapacity: -1, waitMs: 1 })).toThrow(
      RangeError,
    );
    expect(() => createBoundedQueue({ concurrency: 1, queueCapacity: 1, waitMs: 0.5 })).toThrow(
      RangeError,
    );
  });

  it('[AC-B1-06za] the bind refusal’s Retry-After is one full wait in whole seconds', () => {
    expect(BIND_RETRY_AFTER_SEC).toBe(2);
  });
});
