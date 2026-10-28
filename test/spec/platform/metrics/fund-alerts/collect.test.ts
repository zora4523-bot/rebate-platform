// B1-01zzp: collectAutoPayoutDaily(db, clock, capFenOf) over a database stand-in that compiles and
// logs every query but never connects (B1-01zzi's recordingDb). It reads app.withdrawals
// (review_mode, reviewed_at, amount_fen: the BR-WDR-30 ⑨ 口径) and app.config_items (the cap row
// handed to B2-11c's capFenOf), never writes, never reads the database's own clock, and a failed
// read rejects the collection instead of becoming 0. The values themselves are checked against
// PostgreSQL in collect.int.test.ts and default-cap.int.test.ts.
import { expect, it } from 'vitest';
import { FixedClock } from '../../../../../apps/api/src/modules/platform/clock/index.ts';
import { collectAutoPayoutDaily } from '../../../../../apps/api/src/modules/platform/metrics/index.ts';
import { SQL_CLOCK, WRITE_SQL, mentions, recordingDb } from '../../fund-metrics/kit.ts';
import { payoutCapFenOf } from './default-cap-kit.ts';
import { NOW } from './kit.ts';

const TABLES = ['withdrawals', 'config_items'] as const;

/** One collection; a synchronous throw counts as its rejection. */
function collect(answer: (query: string) => readonly Record<string, unknown>[], queries: string[]) {
  const db = recordingDb(queries, answer);
  return Promise.resolve().then(() =>
    collectAutoPayoutDaily(db, new FixedClock(NOW), payoutCapFenOf),
  );
}

it('[AC-B1-01zzp#8] 采集读 withdrawals（按 review_mode、reviewed_at 取 amount_fen）与 config_items：只读、不读数据库时钟；没有行时快照为空而不是报错', async () => {
  const queries: string[] = [];
  const snapshot = await collect(() => [], queries);
  for (const table of TABLES) {
    expect(
      queries.some((q) => mentions(q, table)),
      `collectAutoPayoutDaily reads ${table}`,
    ).toBe(true);
  }
  const reads = queries.filter((q) => mentions(q, 'withdrawals'));
  for (const column of ['review_mode', 'reviewed_at', 'amount_fen']) {
    expect(
      reads.some((q) => new RegExp(`\\b${column}\\b`).test(q)),
      `the withdrawals read uses ${column}`,
    ).toBe(true);
  }
  // net_fen is the payout cap's measure (BR-WDR-13), not ⑨'s.
  expect(reads.filter((q) => /\bnet_fen\b/.test(q))).toEqual([]);
  expect(queries.filter((q) => WRITE_SQL.test(q))).toEqual([]);
  expect(queries.filter((q) => SQL_CLOCK.test(q))).toEqual([]);
  expect(snapshot).toEqual({ totalFen: {}, capFen: {} });
});

it('[AC-B1-01zzp#9] withdrawals 或 config_items 任一读失败时采集拒绝（原错误），不以 0 或空快照代替', async () => {
  for (const table of TABLES) {
    const message = `stand-in: ${table} unavailable`;
    const queries: string[] = [];
    const answer = (query: string) => {
      if (mentions(query, table)) throw new Error(message);
      return [];
    };
    await expect(collect(answer, queries), `${table} fails`).rejects.toThrow(message);
  }
});
