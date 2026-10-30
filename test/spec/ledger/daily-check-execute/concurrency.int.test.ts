// B2-02p: two runs of the same day at once (a retried schedule overlapping the first) still leave
// one recon diff per difference and one hold per involved user: only the run whose INSERT created
// the diff adds the holds (registerReconDiffOnce waits for the other's commit).
import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';
import {
  DAY,
  TIMEOUT,
  balanceCacheDiff,
  diffByRef,
  diffsOf,
  executedOf,
  expectHold,
  holdsOf,
  negativeDropDiff,
  sourceOf,
  userAccount,
  withHarness,
} from './kit.ts';

it(
  '[AC-B2-02p#30] 同日两次运行并发：每张差错单只插入一次，每人每单只 1 条冻结，只有插入方报 inserted',
  async () => {
    await withHarness(createTestDatabase, async (h) => {
      const first = await userAccount(h);
      const second = await userAccount(h);
      const differences = [
        balanceCacheDiff(first, { expected: 300n, cache: 500n }),
        negativeDropDiff(second),
      ];
      const [a, b] = await Promise.all([
        h.executor.execute(h.db, { accountingDate: DAY, differences }),
        h.another().execute(h.db, { accountingDate: DAY, differences }),
      ]);
      const rows = await diffsOf(h);
      expect(rows).toHaveLength(2);
      const cache = await diffByRef(h, `01:${first.accountId}`);
      const negative = await diffByRef(h, `07:${second.accountId}`);
      for (const diff of [cache, negative]) {
        const inserted = [executedOf(a, diff), executedOf(b, diff)].filter((d) => d.inserted);
        expect(inserted, diff.ref_id).toHaveLength(1);
      }
      const holds = await holdsOf(h);
      expect(holds).toHaveLength(2);
      const bySource = new Map(holds.map((hold) => [hold.source_ref, hold]));
      expectHold(bySource.get(sourceOf(cache.id)), cache, first.userId, h);
      expectHold(bySource.get(sourceOf(negative.id)), negative, second.userId, h);
      expect(h.holds.calls).toHaveLength(2);
    });
  },
  TIMEOUT,
);
