import { expect, it } from 'vitest';
import { POOL_SIZES } from '../db/index.ts';
import { WORKER_DB_BUDGET } from './worker-plan.ts';

it('[B1-01zzk] WORKER_DB_BUDGET 是 floor(POOL_SIZES.worker.db × 7 / 10)，至少留 3 个连接', () => {
  expect(WORKER_DB_BUDGET).toBe(Math.floor((POOL_SIZES.worker.db * 7) / 10));
  expect(POOL_SIZES.worker.db - WORKER_DB_BUDGET).toBeGreaterThanOrEqual(3);
});
