import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';
import { LedgerError } from '../../../../apps/api/src/modules/ledger/index.ts';
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
  type Harness,
} from '../posting/kit.ts';

// Run while the caller transaction is still open: checking after its commit/rollback
// would miss a forbidden lock reacquired by post/reverse. No sleeps or timing inference.
async function assertUnlocked(h: Harness, appId: string, accountId: string): Promise<void> {
  await h.right.transaction().execute(async (trx) => {
    await bounded(trx);
    await expect(
      trx
        .selectFrom('account_balances')
        .select('account_id')
        .where('app_id', '=', appId)
        .where('account_id', '=', accountId)
        .forUpdate()
        .noWait()
        .execute(),
    ).resolves.toEqual([{ account_id: accountId }]);
  });
}

it(
  '[AC-B2-02n#3] 回滚后 post 拒绝且不重新取锁；显式重锁、RELEASE 与连续 post 均有效',
  async () => {
    const h = await open(createTestDatabase);
    try {
      const { ledger, appId } = context();
      // Both rows are committed before the savepoint, so ROLLBACK only releases locks.
      const a = await account(h.db, ledger, appId);
      const b = await account(h.db, ledger, appId);
      const first = voucher(appId, a.account_id, -100n);
      const second = voucher(appId, a.account_id, -50n);
      const released = voucher(appId, b.account_id, -70n);
      const before = await snapshot(h.db, appId);

      await h.left.transaction().execute(async (trx) => {
        await bounded(trx);
        await sql`SAVEPOINT caller_locks`.execute(trx);
        expect(await ledger.lockBalances(trx, { appId, userIds: [a.user_id] })).toEqual([a]);
        await sql`ROLLBACK TO SAVEPOINT caller_locks`.execute(trx);
        const attempt = ledger.post(trx, first);
        await expect(attempt).rejects.toBeInstanceOf(LedgerError);
        await expect(attempt).rejects.toMatchObject({ code: 'NOT_LOCKED' });
        expect(await snapshot(trx, appId)).toEqual(before);
        await assertUnlocked(h, appId, a.account_id);

        // The same transaction and same business key can recover by explicitly locking.
        await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
        expect((await ledger.post(trx, first)).kind).toBe('posted');
        expect((await ledger.post(trx, second)).kind).toBe('posted');
        expect(await ledger.getBalances(trx, { appId, userIds: [a.user_id] })).toEqual([
          { ...a, available_fen: 150n, version: 2n },
        ]);

        // RELEASE retains the subtransaction's locks, unlike ROLLBACK TO.
        await sql`SAVEPOINT caller_release`.execute(trx);
        await ledger.lockBalances(trx, { appId, userIds: [b.user_id] });
        await sql`RELEASE SAVEPOINT caller_release`.execute(trx);
        expect((await ledger.post(trx, released)).kind).toBe('posted');
        await sql`RELEASE SAVEPOINT caller_locks`.execute(trx);
      });

      const after = await snapshot(h.db, appId);
      expect(after.vouchers.map((row) => row.uniq_key).sort()).toEqual(
        [first.uniqKey, second.uniqKey, released.uniqKey].sort(),
      );
      expect(after.entries).toHaveLength(6);
      expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
        { ...a, available_fen: 150n, version: 2n },
      ]);
      expect(await ledger.getBalances(h.db, { appId, userIds: [b.user_id] })).toEqual([
        { ...b, available_fen: 70n, version: 1n },
      ]);
    } finally {
      await close(h);
    }
  },
  TIMEOUT,
);

it(
  '[AC-B2-02n#4] 回滚后 reverse 同样 NOT_LOCKED、零写入且不重新取锁；重锁后可红冲',
  async () => {
    const h = await open(createTestDatabase);
    try {
      const { ledger, appId } = context();
      const a = await account(h.db, ledger, appId);
      const original = voucher(appId, a.account_id, -100n);
      await post(h.db, ledger, [a.user_id], original);
      const before = await snapshot(h.db, appId);
      const input = { appId, originalUniqKey: original.uniqKey };

      await h.left.transaction().execute(async (trx) => {
        await bounded(trx);
        await sql`SAVEPOINT caller_reverse`.execute(trx);
        await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
        await sql`ROLLBACK TO SAVEPOINT caller_reverse`.execute(trx);
        const attempt = ledger.reverse(trx, input);
        await expect(attempt).rejects.toBeInstanceOf(LedgerError);
        await expect(attempt).rejects.toMatchObject({ code: 'NOT_LOCKED' });
        expect(await snapshot(trx, appId)).toEqual(before);
        await assertUnlocked(h, appId, a.account_id);

        await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
        expect((await ledger.reverse(trx, input)).kind).toBe('posted');
        await sql`RELEASE SAVEPOINT caller_reverse`.execute(trx);
      });

      const after = await snapshot(h.db, appId);
      expect(after.vouchers.map((row) => row.uniq_key).sort()).toEqual(
        [original.uniqKey, `${original.uniqKey}:REVERSE`].sort(),
      );
      expect(after.entries).toHaveLength(4);
      expect(await ledger.getBalances(h.db, { appId, userIds: [a.user_id] })).toEqual([
        { ...a, available_fen: 0n, version: 2n },
      ]);
    } finally {
      await close(h);
    }
  },
  TIMEOUT,
);
