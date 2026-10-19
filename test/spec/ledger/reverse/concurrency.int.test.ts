import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PostingResult } from '../../../../apps/api/src/modules/ledger/index.ts';
import {
  TIMEOUT,
  account,
  bounded,
  close,
  context,
  open,
  post,
  snapshot,
  voucher,
  waitBlocked,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each(['user', 'platform'] as const)(
  '[AC-B2-02i#14] 两连接并发红冲 %s 凭证只记一次；等待者拿同一结果且事务可继续',
  async (owner) => {
    const { ledger, appId } = context();
    const a = owner === 'user' ? await account(h.db, ledger, appId) : undefined;
    const userIds = a === undefined ? [] : [a.user_id];
    const base = voucher(appId, a?.account_id ?? randomUUID(), -7n);
    const v =
      owner === 'user'
        ? base
        : {
            ...base,
            entries: [
              {
                ...base.entries[0]!,
                account: { ownerType: 'platform' as const, subject: 'PLATFORM_REVENUE' },
              },
              base.entries[1]!,
            ],
          };
    await post(h.db, ledger, userIds, v);
    const before = await snapshot(h.db, appId);
    const input = { appId, originalUniqKey: v.uniqKey };
    const held = Promise.withResolvers<{ pid: number; result: PostingResult }>();
    const release = Promise.withResolvers<void>();
    const first = h.left.transaction().execute(async (trx) => {
      const pid = await bounded(trx);
      await ledger.lockBalances(trx, { appId, userIds });
      const result = await ledger.reverse(trx, input);
      held.resolve({ pid, result });
      await release.promise;
      return result;
    });
    const firstDone = Promise.allSettled([first]);
    let secondDone: Promise<unknown> | undefined;
    try {
      const holder = await Promise.race([
        held.promise,
        first.then(() => {
          throw new Error('first writer did not reach its barrier');
        }),
      ]);
      const started = Promise.withResolvers<number>();
      const second = h.right.transaction().execute(async (trx) => {
        started.resolve(await bounded(trx));
        await ledger.lockBalances(trx, { appId, userIds });
        const result = await ledger.reverse(trx, input);
        expect(result).toEqual({ kind: 'duplicate', voucherId: holder.result.voucherId });
        // Platform case has no balance lock: the wait is on the real unique-index conflict.
        // This post proves 23505 was recovered via SAVEPOINT, not swallowed in an aborted trx.
        expect(
          (await ledger.post(trx, { ...v, uniqKey: `${v.uniqKey}:AFTER_CONFLICT` })).kind,
        ).toBe('posted');
        return result;
      });
      secondDone = Promise.allSettled([second]);
      const waiter = await Promise.race([
        started.promise,
        second.then(() => {
          throw new Error('second writer did not reach its barrier');
        }),
      ]);
      await waitBlocked(h.db, waiter, holder.pid);
      release.resolve();
      expect(await first).toEqual({ kind: 'posted', voucherId: holder.result.voucherId });
      expect(await second).toEqual({ kind: 'duplicate', voucherId: holder.result.voucherId });
    } finally {
      release.resolve();
      await firstDone;
      await secondDone;
    }
    const state = await snapshot(h.db, appId);
    expect(state.vouchers.filter((row) => row.uniq_key === `${v.uniqKey}:REVERSE`)).toHaveLength(1);
    expect(state.vouchers).toHaveLength(3);
    expect(state.entries).toHaveLength(6);
    expect(state.accounts).toEqual(before.accounts);
    expect(state.entries.filter((row) => row.voucher_id === before.vouchers[0]!.id)).toEqual(
      before.entries,
    );
    if (a !== undefined) {
      expect(await ledger.getBalances(h.db, { appId, userIds })).toEqual([
        { ...a, available_fen: 7n, version: 3n },
      ]);
      expect(
        state.entries
          .filter((row) => row.account_id === a.account_id)
          .map((row) => [row.balance_after_fen, row.account_version]),
      ).toEqual([
        [7n, 1n],
        [0n, 2n],
        [7n, 3n],
      ]);
    } else {
      expect(state.balances).toEqual([]);
      expect(
        state.entries.every(
          (row) => row.balance_after_fen === null && row.account_version === null,
        ),
      ).toBe(true);
    }
  },
  TIMEOUT,
);
