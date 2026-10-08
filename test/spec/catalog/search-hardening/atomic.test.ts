import { expect, it, vi } from 'vitest';
import {
  createAtomicSearchSessionStore,
  type AtomicSessionStorage,
} from '../../../../apps/api/src/modules/catalog/infra/search-session-atomic.ts';
import { createRedisSearchSessionStore } from '../../../../apps/api/src/modules/catalog/infra/search-wiring.ts';
import type { RedisNamespace } from '../../../../apps/api/src/modules/platform/index.ts';
import {
  searchProducts,
  type SearchSession,
} from '../../../../apps/api/src/modules/catalog/search.ts';
import { candidate, fixture } from '../search/kit.ts';

/** Opaque atomic storage: no knowledge of JSON, sessions, seen keys, or page numbers.
 * The first two CAS calls after arm() arrive with old snapshots before either may commit.
 * There are no sleeps, timers, scheduler assumptions, or modelled business merge rules.
 */
function storage() {
  const rows = new Map<string, string>();
  let remaining = 0;
  let release: () => void = () => {};
  let gate = Promise.resolve();
  const compareAndSwap = vi.fn(
    async (key: string, expected: string | null, replacement: string, ttlSeconds: number) => {
      void ttlSeconds;
      if (remaining > 0) {
        remaining--;
        if (remaining === 0) release();
        await gate;
      }
      if ((rows.get(key) ?? null) !== expected) return false;
      rows.set(key, replacement);
      return true;
    },
  );
  const port: AtomicSessionStorage = { read: async (key) => rows.get(key) ?? null, compareAndSwap };
  return {
    port,
    rows,
    compareAndSwap,
    arm() {
      remaining = 2;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  };
}

function session(overrides: Partial<SearchSession> = {}): SearchSession {
  return {
    appId: 'synthetic-app',
    requester: 'user:synthetic-user',
    query: { platform: 'taobao', q: 'synthetic', sort: 'relevance', has_coupon: false, limit: 1 },
    touchedAtMs: Date.parse('2026-10-06T10:00:00+08:00'),
    seen: ['tb:synthetic-origin'],
    seenPages: [1],
    dedupDisabled: false,
    ...overrides,
  };
}

it('[AC-B1-05g#22] 两个独立会话存储并发续同一旧快照，不丢任一 seen，后页不再下发', async () => {
  const memory = storage();
  const a = createAtomicSearchSessionStore(memory.port);
  const b = createAtomicSearchSessionStore(memory.port);
  await a.write('synthetic-app', 'synthetic-session', session(), 1800);
  const [beforeA, beforeB] = await Promise.all([
    a.read('synthetic-app', 'synthetic-session'),
    b.read('synthetic-app', 'synthetic-session'),
  ]);
  expect(beforeA).toEqual(beforeB);
  expect(beforeA).not.toBeNull();
  memory.arm();
  await Promise.all([
    a.write(
      'synthetic-app',
      'synthetic-session',
      session({
        seen: [...beforeA!.seen, 'tb:synthetic-a'],
        seenPages: [1, 2],
        touchedAtMs: beforeA!.touchedAtMs + 200,
      }),
      1800,
    ),
    b.write(
      'synthetic-app',
      'synthetic-session',
      session({
        seen: [...beforeB!.seen, 'tb:synthetic-b'],
        seenPages: [1, 2],
        touchedAtMs: beforeB!.touchedAtMs + 100,
      }),
      1800,
    ),
  ]);
  const after = await a.read('synthetic-app', 'synthetic-session');
  expect(new Set(after?.seen)).toEqual(
    new Set(['tb:synthetic-origin', 'tb:synthetic-a', 'tb:synthetic-b']),
  );
  expect(after?.touchedAtMs).toBe(beforeA!.touchedAtMs + 200);
  expect(after?.seen.map((key, index) => [key, after.seenPages?.[index]]).sort()).toEqual([
    ['tb:synthetic-a', 2],
    ['tb:synthetic-b', 2],
    ['tb:synthetic-origin', 1],
  ]);
  expect(memory.compareAndSwap.mock.calls.every(([, , , ttl]) => ttl === 1800)).toBe(true);
  // Public pagination consumes the merged state, rather than asserting only a helper output.
  const f = fixture();
  f.pages.set(3, { items: [candidate('a'), candidate('b'), candidate('new')], hasMore: false });
  const cursor = f.cursors.encode({ search_session_id: 'synthetic-session', page_no: 3 });
  const result = await searchProducts(
    { platform: 'taobao', q: 'synthetic', limit: 1, cursor },
    { ...f.options, sessions: b },
  );
  expect(result.items.map((card) => card.title)).toEqual(['synthetic-new']);
});

it('[AC-B1-05g#23] 并发重复键仅保留一次及最早页号；500 上限合并后熔断去重且不跨 app', async () => {
  const memory = storage();
  const a = createAtomicSearchSessionStore(memory.port);
  const b = createAtomicSearchSessionStore(memory.port);
  const initial = Array.from({ length: 499 }, (_, index) => `tb:synthetic-${index}`);
  await a.write(
    'synthetic-app',
    'synthetic-session',
    session({ seen: initial, seenPages: initial.map(() => 1) }),
    1800,
  );
  memory.arm();
  await Promise.all([
    a.write(
      'synthetic-app',
      'synthetic-session',
      session({
        seen: [...initial, 'tb:synthetic-extra'],
        seenPages: [...initial.map(() => 1), 2],
      }),
      1800,
    ),
    b.write(
      'synthetic-app',
      'synthetic-session',
      session({
        seen: [...initial, 'tb:synthetic-extra', 'tb:synthetic-overflow'],
        seenPages: [...initial.map(() => 1), 3, 3],
      }),
      1800,
    ),
  ]);
  const result = await a.read('synthetic-app', 'synthetic-session');
  expect(result?.dedupDisabled).toBe(true);
  expect(result?.seen.length).toBeLessThanOrEqual(500);
  expect(new Set(result?.seen).size).toBe(result?.seen.length);
  const index = result?.seen.indexOf('tb:synthetic-extra') ?? -1;
  if (index >= 0) expect(result?.seenPages?.[index]).toBe(2);
  expect(await b.read('synthetic-other-app', 'synthetic-session')).toBeNull();
  // A late writer with an older snapshot cannot re-enable deduplication.
  await b.write('synthetic-app', 'synthetic-session', session(), 1800);
  expect((await a.read('synthetic-app', 'synthetic-session'))?.dedupDisabled).toBe(true);
});

it('[AC-B1-05g#25] 生产 Redis 会话工厂也通过原子命令保留两个实例的 seen 增量', async () => {
  const memory = storage();
  // The fake implements only Redis's opaque CAS storage contract, never a seen-set union.
  const redis: RedisNamespace = {
    get: memory.port.read,
    set: async (key, value) => {
      memory.rows.set(key, value);
    },
    eval: vi.fn(async (_script, options) => {
      expect(options.keys).toHaveLength(1);
      expect(options.args).toHaveLength(2);
      const wrote = await memory.port.compareAndSwap(
        options.keys[0]!,
        options.args[0] === '' ? null : options.args[0]!,
        options.args[1]!,
        options.ttlSeconds,
      );
      return wrote ? 1 : 0;
    }),
  };
  const a = createRedisSearchSessionStore(redis);
  const b = createRedisSearchSessionStore(redis);
  await a.write('synthetic-app', 'synthetic-session', session(), 1800);
  // Both applications have already loaded the same session before either writes its page.
  const [snapshotA, snapshotB] = await Promise.all([
    a.read('synthetic-app', 'synthetic-session'),
    b.read('synthetic-app', 'synthetic-session'),
  ]);
  expect(snapshotA).not.toBeNull();
  expect(snapshotB).toEqual(snapshotA);
  memory.arm();
  await Promise.all([
    a.write(
      'synthetic-app',
      'synthetic-session',
      { ...snapshotA!, seen: [...snapshotA!.seen, 'tb:synthetic-a'], seenPages: [1, 2] },
      1800,
    ),
    b.write(
      'synthetic-app',
      'synthetic-session',
      { ...snapshotB!, seen: [...snapshotB!.seen, 'tb:synthetic-b'], seenPages: [1, 2] },
      1800,
    ),
  ]);
  const merged = await a.read('synthetic-app', 'synthetic-session');
  expect(new Set(merged?.seen)).toEqual(
    new Set(['tb:synthetic-origin', 'tb:synthetic-a', 'tb:synthetic-b']),
  );
  expect(redis.eval).toHaveBeenCalled();
  expect(memory.compareAndSwap.mock.calls.every(([, , , ttl]) => ttl === 1800)).toBe(true);
});
