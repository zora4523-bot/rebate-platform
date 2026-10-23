import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  TIMEOUT,
  account,
  bounded,
  change,
  close,
  context,
  entry,
  mark,
  markers,
  open,
  post,
  snapshot,
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

it('[AC-B2-04ka#8] 调用方回滚同时撤销凭证、余额回正与清理，重试完整提交', async () => {
  const { ledger, appId, onRecovered } = context();
  const a = await account(h.db, ledger, appId);
  await post(h.db, ledger, [a.user_id], change(appId, a.account_id, 300n));
  const before = await snapshot(h.db, appId);
  const v = change(appId, a.account_id, -500n, 'REBATE_CREDIT');
  const abort = new Error('caller rollback');
  await expect(
    h.db.transaction().execute(async (trx) => {
      await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
      await ledger.post(trx, v);
      expect(onRecovered).toHaveBeenCalledTimes(1);
      expect(await markers(trx, appId, a.account_id)).toHaveLength(1);
      expect(await markers(h.right, appId, a.account_id)).toEqual([]);
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await snapshot(h.db, appId)).toEqual(before);
  expect(await markers(h.db, appId, a.account_id)).toEqual([]);
  expect((await post(h.db, ledger, [a.user_id], v)).kind).toBe('posted');
  expect(onRecovered).toHaveBeenCalledTimes(2);
  expect(await markers(h.db, appId, a.account_id)).toHaveLength(1);
});

it.each(['throw', 'sql-error'] as const)(
  '[AC-B2-04ka#9] 第二个账户清理发生 %s，整张凭证与先前清理回滚，外层事务仍能重试',
  async (failureMode) => {
    const { ledger, appId, onRecovered } = context();
    const a = await account(h.db, ledger, appId);
    const b = await account(h.db, ledger, appId);
    for (const row of [a, b]) {
      await post(h.db, ledger, [row.user_id], change(appId, row.account_id, 1n));
    }
    const before = await snapshot(h.db, appId);
    const base = change(appId, a.account_id, -1n, 'REBATE_CREDIT');
    const v = {
      ...base,
      entries: [
        entry(a.account_id, -1n),
        entry(b.account_id, -1n),
        { ...base.entries[1]!, amount_fen: 2n },
      ],
    };
    const failure = new Error('cleanup failed');
    await h.db.transaction().execute(async (trx) => {
      await ledger.lockBalances(trx, { appId, userIds: [a.user_id, b.user_id] });
      // Caller-owned write predates post's savepoint and must survive the cleanup failure.
      const callerMarker = {
        appId,
        accountId: 'caller',
        userId: a.user_id,
        availableBefore: -1n,
        availableAfter: -1n,
        voucherId: randomUUID(),
      };
      await mark(trx, callerMarker);
      onRecovered.mockImplementationOnce(mark).mockImplementationOnce(async (hookTrx, input) => {
        await mark(hookTrx, input);
        if (failureMode === 'sql-error') {
          // Real PG constraint failure aborts the subtransaction; a JS catch alone cannot fix it.
          await mark(hookTrx, input);
        }
        throw failure;
      });
      const attempt = ledger.post(trx, v);
      if (failureMode === 'throw') await expect(attempt).rejects.toBe(failure);
      else await expect(attempt).rejects.toMatchObject({ code: '23505' });
      expect(onRecovered).toHaveBeenCalledTimes(2);
      expect(await snapshot(trx, appId)).toEqual(before);
      expect(await markers(trx, appId, a.account_id)).toEqual([]);
      expect(await markers(trx, appId, b.account_id)).toEqual([]);
      expect(await markers(trx, appId, 'caller')).toHaveLength(1);
      expect((await ledger.post(trx, v)).kind).toBe('posted');
    });
    expect(onRecovered).toHaveBeenCalledTimes(4);
    for (const row of [a, b]) {
      expect(await markers(h.db, appId, row.account_id)).toHaveLength(1);
      expect((await ledger.getBalances(h.db, { appId, userIds: [row.user_id] }))[0]).toMatchObject({
        available_fen: 0n,
        negative_since: null,
      });
    }
    expect(await markers(h.db, appId, 'caller')).toHaveLength(1);
  },
);

it('[AC-B2-04ka#10] post 必须等待异步清理完成才返回，不能提交后另行处理', async () => {
  const { ledger, appId, onRecovered } = context();
  const a = await account(h.db, ledger, appId);
  await post(h.db, ledger, [a.user_id], change(appId, a.account_id, 1n));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  onRecovered.mockImplementationOnce(async (trx, input) => {
    entered.resolve();
    await release.promise;
    await mark(trx, input);
  });
  await h.db.transaction().execute(async (trx) => {
    await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
    let settled = false;
    const pending = ledger.post(trx, change(appId, a.account_id, -1n, 'REBATE_CREDIT'));
    const observed = pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      const first = await Promise.race([
        entered.promise.then(() => 'entered'),
        pending.then(() => 'returned'),
      ]);
      expect(first).toBe('entered');
      // Drain the current turn while the port is explicitly held, without relying on a sleep.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(await markers(h.right, appId, a.account_id)).toEqual([]);
    } finally {
      release.resolve();
      await observed;
    }
    expect((await pending).kind).toBe('posted');
    expect(await markers(trx, appId, a.account_id)).toHaveLength(1);
  });
  expect(await markers(h.db, appId, a.account_id)).toHaveLength(1);
});

it.each(['same-voucher', 'different-voucher'] as const)(
  '[AC-B2-04ka#11] 并发 %s 在余额锁后判定，只清理首次回正',
  async (mode) => {
    const { ledger, appId, onRecovered } = context();
    const a = await account(h.db, ledger, appId);
    await post(h.db, ledger, [a.user_id], change(appId, a.account_id, 1n));
    const v = change(appId, a.account_id, -1n, 'REBATE_CREDIT');
    const ready = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const waiter = Promise.withResolvers<number>();
    const left = h.left.transaction().execute(async (trx) => {
      const pid = await bounded(trx);
      await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
      const result = await ledger.post(trx, v);
      ready.resolve(pid);
      await release.promise;
      return result;
    });
    const leftDone = Promise.allSettled([left]);
    let rightDone: Promise<unknown> | undefined;
    try {
      const pid = await Promise.race([
        ready.promise,
        left.then(() => {
          throw new Error('missing holder barrier');
        }),
      ]);
      const right = h.right.transaction().execute(async (trx) => {
        waiter.resolve(await bounded(trx));
        await ledger.lockBalances(trx, { appId, userIds: [a.user_id] });
        return ledger.post(trx, mode === 'same-voucher' ? v : { ...v, uniqKey: randomUUID() });
      });
      rightDone = Promise.allSettled([right]);
      const waiterPid = await Promise.race([
        waiter.promise,
        right.then(() => {
          throw new Error('missing waiter barrier');
        }),
      ]);
      await waitBlocked(h.control, waiterPid, pid);
      release.resolve();
      const first = await left;
      const second = await right;
      expect(first.kind).toBe('posted');
      expect(second.kind).toBe(mode === 'same-voucher' ? 'duplicate' : 'posted');
      if (mode === 'same-voucher') expect(second.voucherId).toBe(first.voucherId);
      expect(onRecovered).toHaveBeenCalledTimes(1);
      expect(onRecovered.mock.calls[0]?.[1]).toMatchObject({
        availableBefore: -1n,
        availableAfter: 0n,
        voucherId: first.voucherId,
      });
      expect(await markers(h.db, appId, a.account_id)).toHaveLength(1);
      expect(
        (await ledger.getBalances(h.db, { appId, userIds: [a.user_id] }))[0]?.available_fen,
      ).toBe(mode === 'same-voucher' ? 0n : 1n);
    } finally {
      release.resolve();
      await leftDone;
      await rightDone;
    }
  },
  TIMEOUT,
);

it('[AC-B2-04ka#12] 同凭证另一账户发生禁止扣负时不留下回正清理', async () => {
  const { ledger, appId, onRecovered } = context();
  const a = await account(h.db, ledger, appId);
  const b = await account(h.db, ledger, appId);
  await post(h.db, ledger, [a.user_id], change(appId, a.account_id, 1n));
  const before = await snapshot(h.db, appId);
  const base = change(appId, a.account_id, -1n, 'REBATE_CREDIT');
  await expect(
    post(h.db, ledger, [a.user_id, b.user_id], {
      ...base,
      entries: [
        entry(a.account_id, -1n),
        entry(b.account_id, 2n, 'WITHDRAW_FEE'),
        { ...base.entries[1]!, amount_fen: -1n },
      ],
    }),
  ).rejects.toMatchObject({ code: 'NEGATIVE_BALANCE' });
  expect(await snapshot(h.db, appId)).toEqual(before);
  expect(onRecovered).not.toHaveBeenCalled();
  expect(await markers(h.db, appId, a.account_id)).toEqual([]);
});
