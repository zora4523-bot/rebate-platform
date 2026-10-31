import { expect, it } from 'vitest';
import { poolRawFetchedMs } from './pool-read.ts';

const EARLY = new Date('2026-10-01T00:00:00+08:00');
const LATE = new Date('2026-10-04T00:00:00+08:00');

it('[AC-B1-05r-unit#2] 刷新挪过 quoted_at 的行：取得时刻是入池时刻', () => {
  expect(poolRawFetchedMs({ created_at: EARLY, quoted_at: LATE })).toBe(EARLY.getTime());
});

it('[AC-B1-05r-unit#3] 刚入池而 quoted_at 旧的行：取得时刻是 quoted_at', () => {
  expect(poolRawFetchedMs({ created_at: LATE, quoted_at: EARLY })).toBe(EARLY.getTime());
});
