import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  registerReconDiff,
  type ReconDiff,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { bounded, waitBlocked } from '../posting/kit.ts';
import { TIMEOUT, close, fixture, open, rows, type Harness } from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each(['business', 'dedupe', 'month'] as const)(
  '[AC-B2-04k#11] 并发命中 %s 唯一键时等待提交、返回胜者，调用方事务仍可继续写',
  async (key) => {
    const { input, clock } = fixture({
      ...(key === 'dedupe' ? { dedupeKey: 'concurrent' } : {}),
      ...(key === 'month' ? { type: 'month_end_unbalanced', period: '2032-06' } : {}),
    });
    const contender = key === 'business' ? input : { ...input, refId: randomUUID() };
    const ready = Promise.withResolvers<{ pid: number; row: ReconDiff }>();
    const release = Promise.withResolvers<void>();
    const waiter = Promise.withResolvers<number>();
    const left = h.left.transaction().execute(async (trx) => {
      const pid = await bounded(trx);
      const row = await registerReconDiff(trx, input, { clock });
      ready.resolve({ pid, row });
      await release.promise;
      return row;
    });
    const leftDone = Promise.allSettled([left]);
    let right: Promise<ReconDiff> | undefined;
    let rightDone: Promise<PromiseSettledResult<ReconDiff>[]> | undefined;
    try {
      const held = await Promise.race([
        ready.promise,
        left.then(() => {
          throw new Error('missing registration barrier');
        }),
      ]);
      right = h.right.transaction().execute(async (trx) => {
        waiter.resolve(await bounded(trx));
        const row = await registerReconDiff(trx, contender, { clock });
        // A recovered unique violation must not leave the transaction aborted (25P02).
        const extra = await registerReconDiff(
          trx,
          { ...input, type: 'platform_restore', refId: randomUUID(), dedupeKey: null },
          { clock },
        );
        expect(extra.id).not.toBe(row.id);
        return row;
      });
      rightDone = Promise.allSettled([right]);
      const pid = await Promise.race([
        waiter.promise,
        right.then(() => {
          throw new Error('missing contender barrier');
        }),
      ]);
      await waitBlocked(h.db, pid, held.pid);
      release.resolve();
      expect(await right).toEqual(await left);
      expect(await rows(h.db, input.appId)).toHaveLength(2);
    } finally {
      release.resolve();
      await leftDone;
      await rightDone;
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-04k#12] 未提交登记回滚后，等待同去重键的事务成为唯一成功登记者',
  async () => {
    const { input, clock } = fixture({ dedupeKey: 'rollback-race' });
    const ready = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const waiter = Promise.withResolvers<number>();
    const abort = new Error('holder rollback');
    const left = h.left.transaction().execute(async (trx) => {
      const pid = await bounded(trx);
      await registerReconDiff(trx, input, { clock });
      ready.resolve(pid);
      await release.promise;
      throw abort;
    });
    const leftDone = Promise.allSettled([left]);
    let rightDone: Promise<PromiseSettledResult<ReconDiff>[]> | undefined;
    try {
      const pid = await Promise.race([ready.promise, left]);
      const nextRef = randomUUID();
      const right = h.right.transaction().execute(async (trx) => {
        waiter.resolve(await bounded(trx));
        return registerReconDiff(trx, { ...input, refId: nextRef }, { clock });
      });
      rightDone = Promise.allSettled([right]);
      const waiterPid = await Promise.race([
        waiter.promise,
        right.then(() => {
          throw new Error('missing contender barrier');
        }),
      ]);
      await waitBlocked(h.db, waiterPid, pid);
      release.resolve();
      const row = await right;
      expect((await leftDone)[0]).toEqual({ status: 'rejected', reason: abort });
      expect(row.ref_id).toBe(nextRef);
      expect(await rows(h.db, input.appId)).toEqual([row]);
    } finally {
      release.resolve();
      await leftDone;
      await rightDone;
    }
  },
  TIMEOUT,
);
