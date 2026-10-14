// B3-03e: sweeper parameters (design §10.1 T10: margin 10 s, page 100, 500 per pass; §5.1
// sweepMarginMs ≥ 0) and the cursor start of design §5.3 ('-infinity', all-zero UUID). No database:
// createSweeper validates its configuration before touching anything.
import type { DB } from '@couli/db';
import type { Kysely } from 'kysely';
import { expect, it } from 'vitest';

import { FixedClock } from '../../../../apps/api/src/modules/platform/clock/index.ts';
import {
  sweepStart,
  createSweeper,
  sweeperDefaults,
  type SweeperConfig,
} from '../../../../apps/api/src/modules/agent/stream/sweeper/index.ts';

const unusedDb = {} as Kysely<DB>;
const unusedFinalizer = {
  finalize: () => Promise.reject(new Error('finalize must not be called while building')),
};

it('[AC-B3-03e#1] 默认参数：余量 10 s、每页 100、单轮 500；游标起点为 (-infinity, 全零 UUID)', () => {
  expect(sweeperDefaults()).toEqual({ marginMs: 10_000, pageSize: 100, maxPerTick: 500 });
  expect(sweepStart()).toEqual({
    lockExpiresAt: null,
    sessionId: '00000000-0000-0000-0000-000000000000',
  });
  expect(Object.isFrozen(sweepStart())).toBe(true);
});

it('[AC-B3-03e#2] 参数校验：marginMs 须为 ≥ 0 的安全整数、pageSize / maxPerTick 须为 ≥ 1 的安全整数，否则 createSweeper 抛 RangeError；余量 0 合法', () => {
  const base = sweeperDefaults();
  const build = (config: SweeperConfig) =>
    createSweeper({
      db: unusedDb,
      finalizer: unusedFinalizer,
      clock: new FixedClock('2026-10-06T10:00:00+08:00'),
      config,
    });
  const invalid: [string, SweeperConfig][] = [
    ['margin -1', { ...base, marginMs: -1 }],
    ['margin 1.5', { ...base, marginMs: 1.5 }],
    ['margin NaN', { ...base, marginMs: Number.NaN }],
    ['margin Infinity', { ...base, marginMs: Number.POSITIVE_INFINITY }],
    ['page 0', { ...base, pageSize: 0 }],
    ['page 2.5', { ...base, pageSize: 2.5 }],
    ['page -1', { ...base, pageSize: -1 }],
    ['perTick 0', { ...base, maxPerTick: 0 }],
    ['perTick 1.5', { ...base, maxPerTick: 1.5 }],
  ];
  for (const [label, config] of invalid) {
    expect(() => build(config), label).toThrow(RangeError);
  }
  expect(() => build({ ...base, marginMs: 0 })).not.toThrow();
  expect(() => build({ marginMs: 0, pageSize: 1, maxPerTick: 1 })).not.toThrow();
});
