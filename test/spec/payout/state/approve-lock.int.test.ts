import type { DB } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import type { Kysely, Transaction } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { bounded, voucher, waitBlocked } from '../../ledger/posting/kit.ts';
import {
  close,
  invariant,
  open,
  setup,
  snapshot,
  TIMEOUT,
  withdrawal,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

function vouchers(db: Kysely<DB>, appId: string) {
  // Include every voucher type: an illicit W2 posting must not evade the assertion.
  return db
    .withSchema('app')
    .selectFrom('ledger_vouchers')
    .selectAll()
    .where('app_id', '=', appId)
    .orderBy('id')
    .execute();
}

it.each(['debit_first', 'approve_first'] as const)(
  '[AC-B2-05e#44] W2 与扣回按真实行锁串行：%s，余额判断使用获得锁后的值',
  async (order) => {
    const f = await setup(h, 100n);
    // Keep the skeleton error outside asynchronous race cleanup and expected outcomes.
    const commands = f.commands();
    const id = await f.startWithdrawal(100n);
    const before = await snapshot(f);
    const beforeVouchers = await vouchers(h.db, f.actor.appId);
    expect(before.balances[0]).toMatchObject({ available_fen: 0n, frozen_fen: 100n });
    const debit = voucher(f.actor.appId, before.balances[0]!.account_id, 1n);
    async function deduct(trx: Transaction<DB>) {
      const who = { appId: f.actor.appId, userIds: [f.actor.userId] };
      await f.ledger.lockBalances(trx, who);
      await f.ledger.post(trx, {
        ...debit,
        entries: debit.entries.map((entry) => ({ ...entry, ledger_type: 'ADMIN_ADJUST' })),
      });
    }

    const holder = await h.observer.startTransaction().execute();
    try {
      const waiter = await h.db.startTransaction().execute();
      let pending: Promise<unknown> | undefined;
      try {
        const holderPid = await bounded(holder);
        const waiterPid = await bounded(waiter);
        expect(waiterPid).not.toBe(holderPid);
        if (order === 'debit_first') {
          await deduct(holder);
          expect((await snapshot(f, holder)).balances[0]).toMatchObject({
            available_fen: -1n,
            frozen_fen: 100n,
          });
        } else {
          expect(await commands.approve(holder, f.command(id))).toEqual({
            kind: 'changed',
            status: 'APPROVED',
          });
          expect(await vouchers(holder, f.actor.appId)).toEqual(beforeVouchers);
        }
        // The other connection still sees the original state while the holder is uncommitted.
        expect(await snapshot(f, waiter)).toEqual(before);
        pending = (
          order === 'debit_first' ? commands.approve(waiter, f.command(id)) : deduct(waiter)
        ).then(
          (result) => ({ kind: 'fulfilled', result }),
          (error: unknown) => ({ kind: 'rejected', error }),
        );
        // Query the exact two backend PIDs, not elapsed time or a lock spy.
        await waitBlocked(holder, waiterPid, holderPid);
        await holder.commit().execute();
        expect(await pending).toEqual({
          kind: 'fulfilled',
          result:
            order === 'debit_first' ? { kind: 'refused', reason: 'negative_balance' } : undefined,
        });
        await waiter.commit().execute();
      } finally {
        // Release the blocker before draining the waiter, including assertion failures.
        if (!holder.isCommitted && !holder.isRolledBack) await holder.rollback().execute();
        await pending;
        if (!waiter.isCommitted && !waiter.isRolledBack) await waiter.rollback().execute();
      }
    } finally {
      if (!holder.isCommitted && !holder.isRolledBack) await holder.rollback().execute();
    }

    const after = await snapshot(f);
    expect(await withdrawal(f, id)).toMatchObject({
      status: order === 'debit_first' ? 'PENDING_REVIEW' : 'APPROVED',
      row_version: order === 'debit_first' ? 0 : 1,
      amount_fen: 100n,
    });
    if (order === 'debit_first') expect(after.withdrawals).toEqual(before.withdrawals);
    expect(after.balances[0]).toMatchObject({ available_fen: -1n, frozen_fen: 100n });
    expect(after.vouchers).toEqual(before.vouchers);
    const afterVouchers = await vouchers(h.db, f.actor.appId);
    expect(afterVouchers.filter((row) => row.uniq_key === debit.uniqKey)).toHaveLength(1);
    expect(afterVouchers.filter((row) => row.uniq_key !== debit.uniqKey)).toEqual(beforeVouchers);
    await invariant(f);
  },
  TIMEOUT,
);
