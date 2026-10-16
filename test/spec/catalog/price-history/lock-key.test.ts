// B1-17b: the advisory lock key of price_snapshot (BR-WATCH-05: 对 (app_id, product_key,
// source_kind) 取事务级 advisory lock; orchestrator semantics B.3: 三者任一不同就是不同的锁).
// That the store really waits on this key is proven in store.int.test.ts.
import { propParams } from '@couli/testing';
import fc from 'fast-check';
import { expect, it } from 'vitest';
import {
  priceSnapshotLockKey,
  type PriceSnapshotSourceKind,
} from '../../../../apps/api/src/modules/catalog/index.ts';

const MIN_INT8 = -(2n ** 63n);
const MAX_INT8 = 2n ** 63n - 1n;

it('[AC-B1-17b#20] 同一键两次得到同一个 bigint，且在 pg_advisory_xact_lock(bigint) 的有符号 64 位范围内', () => {
  const first = priceSnapshotLockKey('app-a', 'tb:123', 'detail');
  const second = priceSnapshotLockKey('app-a', 'tb:123', 'detail');
  expect(typeof first).toBe('bigint');
  expect(second).toBe(first);
  expect(first >= MIN_INT8 && first <= MAX_INT8).toBe(true);
}, 10_000);

it('[AC-B1-17b#21] app_id、product_key、source_kind 任一不同 → 锁键不同', () => {
  const base = priceSnapshotLockKey('app-a', 'tb:123', 'detail');
  expect(priceSnapshotLockKey('app-b', 'tb:123', 'detail')).not.toBe(base);
  expect(priceSnapshotLockKey('app-a', 'tb:124', 'detail')).not.toBe(base);
  for (const kind of ['search', 'quote', 'convert', 'watch'] as const) {
    expect(priceSnapshotLockKey('app-a', 'tb:123', kind)).not.toBe(base);
  }
}, 10_000);

it.each([':', '|', '/', ' ', ',', ';', '\u0000', '\t'])(
  '[AC-B1-17b#22] 拼接无歧义：分隔符 %j 挪到 app_id 与 product_key 之间不同侧时锁键不同',
  (sep) => {
    const left = priceSnapshotLockKey(`a${sep}b`, 'c', 'detail');
    const right = priceSnapshotLockKey('a', `b${sep}c`, 'detail');
    expect(left).not.toBe(right);
    const kindLeft = priceSnapshotLockKey('a', `b${sep}detail`, 'search');
    const kindRight = priceSnapshotLockKey('a', `b${sep}search`, 'detail');
    expect(kindLeft).not.toBe(kindRight);
  },
  10_000,
);

const kindArb = fc.constantFrom<PriceSnapshotSourceKind>(
  'search',
  'detail',
  'quote',
  'convert',
  'watch',
);
const tripleArb = fc.tuple(fc.string({ maxLength: 12 }), fc.string({ maxLength: 12 }), kindArb);

it('[AC-B1-17b#23] 属性：任意两组不同的三元组锁键不同、同一三元组锁键稳定且在 int8 范围内', () => {
  let checked = 0;
  fc.assert(
    fc.property(tripleArb, tripleArb, ([a1, p1, k1], [a2, p2, k2]) => {
      const key1 = priceSnapshotLockKey(a1, p1, k1);
      expect(key1 >= MIN_INT8 && key1 <= MAX_INT8).toBe(true);
      expect(priceSnapshotLockKey(a1, p1, k1)).toBe(key1);
      const sameTriple = a1 === a2 && p1 === p2 && k1 === k2;
      expect(priceSnapshotLockKey(a2, p2, k2) === key1).toBe(sameTriple);
      checked += 1;
    }),
    propParams(),
  );
  expect(checked).toBeGreaterThan(0);
}, 120_000);
