// B2-05k (BR-WDR-05 (a), BR-FUND-12): the posting transaction that takes a member's available
// from < 0 to >= 0 clears blocked_reason = NEGATIVE_BALANCE on that member's withdrawals, through
// payout's recovery port inside ledger's voucher savepoint. Real PG, real ledger, real port.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  NEGATIVE_BALANCE,
  TIMEOUT,
  accountOf,
  balanceOf,
  block,
  books,
  changeAvailable,
  close,
  creditVoucher,
  entry,
  expectOnlyVoucher,
  fixture,
  locked,
  open,
  recovering,
  seedStatus,
  setup,
  success,
  withdrawal,
  withdrawalsOf,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each([
  [1n, 0n],
  [51n, 50n],
])(
  '[AC-B2-05k#1] −1 入账 %s 回到 %s：同一事务内 APPROVED 与 PAYING 的阻断清空，提交后可见，状态金额不变、row_version +1、updated_at 取挂点 Clock',
  async (credit, after) => {
    const { ledger, hookClock } = recovering();
    const f = await setup(h, 300n);
    const approved = await f.startWithdrawal();
    const paying = await f.startWithdrawal();
    const pending = await f.startWithdrawal();
    await seedStatus(f, approved, 'APPROVED');
    await seedStatus(f, paying, 'PAYING');
    await changeAvailable(f, -1n);
    await block(f, approved);
    await block(f, paying);
    // Same app, another member; and another app's member: their blocks are not this recovery's.
    const sibling = await fixture(h, { appId: f.actor.appId, balance: 100n });
    const siblingId = success(
      await h.db.transaction().execute((trx) => sibling.apply(trx, 100n)),
    ).withdrawal_id;
    await block(sibling, siblingId);
    const other = await setup(h, 100n);
    const otherId = await other.startWithdrawal();
    await block(other, otherId);
    expect(await balanceOf(f)).toMatchObject({ available_fen: -1n, frozen_fen: 300n });

    const rowsBefore = await withdrawalsOf(h.db, f.actor.appId);
    const otherBefore = await withdrawalsOf(h.db, other.actor.appId);
    const booksBefore = await books(h.db, f.actor.appId);
    const approvedBefore = await withdrawal(f, approved);
    const payingBefore = await withdrawal(f, paying);
    const accountId = await accountOf(f);

    const posted = await locked(h.db, ledger, f.actor.appId, [f.actor.userId], async (trx) => {
      const result = await ledger.post(trx, creditVoucher(f.actor.appId, accountId, credit));
      expect(result.kind).toBe('posted');
      // Inside the posting transaction the block is already gone; outside it is not yet.
      for (const id of [approved, paying]) {
        expect((await withdrawal(f, id, trx)).blocked_reason).toBeNull();
        expect((await withdrawal(f, id, h.observer)).blocked_reason).toBe(NEGATIVE_BALANCE);
      }
      return result;
    });

    expect(await withdrawal(f, approved)).toEqual({
      ...approvedBefore,
      status: 'APPROVED',
      blocked_reason: null,
      updated_at: hookClock.now(),
      row_version: approvedBefore.row_version + 1,
    });
    expect(await withdrawal(f, paying)).toEqual({
      ...payingBefore,
      status: 'PAYING',
      blocked_reason: null,
      updated_at: hookClock.now(),
      row_version: payingBefore.row_version + 1,
    });
    // The member's unblocked withdrawal and the sibling's blocked one are untouched.
    const rowsAfter = await withdrawalsOf(h.db, f.actor.appId);
    expect(rowsAfter.filter((row) => row.id !== approved && row.id !== paying)).toEqual(
      rowsBefore.filter((row) => row.id !== approved && row.id !== paying),
    );
    expect(rowsAfter.find((row) => row.id === pending)?.row_version).toBe(
      rowsBefore.find((row) => row.id === pending)?.row_version,
    );
    expect(rowsAfter.find((row) => row.id === siblingId)?.blocked_reason).toBe(NEGATIVE_BALANCE);
    expect(await withdrawalsOf(h.db, other.actor.appId)).toEqual(otherBefore);
    // Money: only the credit itself moved; the port wrote no voucher, entry or event.
    expect(await balanceOf(f)).toMatchObject({
      available_fen: after,
      frozen_fen: 300n,
      negative_since: null,
    });
    expectOnlyVoucher(booksBefore, await books(h.db, f.actor.appId), posted.voucherId, 2);
  },
);

it('[AC-B2-05k#1] 一张凭证同时让同 app 两名会员回正：两人的阻断都在该事务内清空', async () => {
  const { ledger, hookClock } = recovering();
  const a = await setup(h, 100n);
  const b = await fixture(h, { appId: a.actor.appId, balance: 100n });
  const aId = await a.startWithdrawal();
  const bId = success(await h.db.transaction().execute((trx) => b.apply(trx, 100n))).withdrawal_id;
  await seedStatus(a, aId, 'APPROVED');
  await seedStatus(b, bId, 'APPROVED');
  await changeAvailable(a, -1n);
  await changeAvailable(b, -2n);
  await block(a, aId);
  await block(b, bId);
  const aBefore = await withdrawal(a, aId);
  const bBefore = await withdrawal(b, bId);
  const aAccount = await accountOf(a);
  const bAccount = await accountOf(b);
  const base = creditVoucher(a.actor.appId, aAccount, 1n);
  await locked(h.db, ledger, a.actor.appId, [a.actor.userId, b.actor.userId], async (trx) => {
    const result = await ledger.post(trx, {
      ...base,
      entries: [
        entry(aAccount, -1n),
        entry(bAccount, -2n),
        { ...base.entries[1]!, amount_fen: 3n },
      ],
    });
    expect(result.kind).toBe('posted');
  });
  for (const [f, id, before] of [
    [a, aId, aBefore],
    [b, bId, bBefore],
  ] as const) {
    expect(await withdrawal(f, id)).toEqual({
      ...before,
      blocked_reason: null,
      updated_at: hookClock.now(),
      row_version: before.row_version + 1,
    });
    expect((await balanceOf(f)).available_fen).toBe(0n);
  }
});

it('[AC-B2-05k#2] 回正的 post 在同一事务里随后回滚：阻断保留，余额、分录、凭证都不变', async () => {
  const { ledger } = recovering();
  const f = await setup(h, 200n);
  const approved = await f.startWithdrawal();
  const paying = await f.startWithdrawal();
  await seedStatus(f, approved, 'APPROVED');
  await seedStatus(f, paying, 'PAYING');
  await changeAvailable(f, -1n);
  await block(f, approved);
  await block(f, paying);
  const rowsBefore = await withdrawalsOf(h.db, f.actor.appId);
  const booksBefore = await books(h.db, f.actor.appId);
  const accountId = await accountOf(f);
  const rollback = new Error('synthetic rollback after the recovering post');
  await expect(
    locked(h.db, ledger, f.actor.appId, [f.actor.userId], async (trx) => {
      const result = await ledger.post(trx, creditVoucher(f.actor.appId, accountId, 1n));
      expect(result.kind).toBe('posted');
      // The clearing did run on this transaction, so the rollback is what undoes it.
      expect((await withdrawal(f, approved, trx)).blocked_reason).toBeNull();
      expect((await withdrawal(f, paying, trx)).blocked_reason).toBeNull();
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await withdrawalsOf(h.db, f.actor.appId)).toEqual(rowsBefore);
  expect(await books(h.db, f.actor.appId)).toEqual(booksBefore);
  expect(await balanceOf(f)).toMatchObject({ available_fen: -1n, frozen_fen: 200n });
});

it('[AC-B2-05k#3] 入账后仍为负（−5 → −2）挂点不调用、阻断不清；再入账到 0 才清', async () => {
  const { ledger, hook, hookClock } = recovering();
  const spy = vi.spyOn(hook, 'onRecovered');
  const f = await setup(h, 100n);
  const id = await f.startWithdrawal();
  await seedStatus(f, id, 'APPROVED');
  await changeAvailable(f, -5n);
  await block(f, id);
  const before = await withdrawal(f, id);
  const accountId = await accountOf(f);
  await locked(h.db, ledger, f.actor.appId, [f.actor.userId], (trx) =>
    ledger.post(trx, creditVoucher(f.actor.appId, accountId, 3n)),
  );
  expect((await balanceOf(f)).available_fen).toBe(-2n);
  expect(spy).not.toHaveBeenCalled();
  expect(await withdrawal(f, id)).toEqual(before);

  const posted = await locked(h.db, ledger, f.actor.appId, [f.actor.userId], (trx) =>
    ledger.post(trx, creditVoucher(f.actor.appId, accountId, 2n)),
  );
  expect((await balanceOf(f)).available_fen).toBe(0n);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0]?.[1]).toEqual({
    appId: f.actor.appId,
    userId: f.actor.userId,
    accountId,
    availableBefore: -2n,
    availableAfter: 0n,
    voucherId: posted.voucherId,
  });
  expect(await withdrawal(f, id)).toEqual({
    ...before,
    blocked_reason: null,
    updated_at: hookClock.now(),
    row_version: before.row_version + 1,
  });
});

it.each([-1n, -300n])(
  '[AC-B2-05k#3] 端口被直接以 availableAfter=%s（仍为负）调用时防御性返回，不写任何行',
  async (availableAfter) => {
    const { hook } = recovering();
    const f = await setup(h, 100n);
    const id = await f.startWithdrawal();
    await seedStatus(f, id, 'APPROVED');
    await changeAvailable(f, -5n);
    await block(f, id);
    const rowsBefore = await withdrawalsOf(h.db, f.actor.appId);
    const booksBefore = await books(h.db, f.actor.appId);
    const accountId = await accountOf(f);
    await h.db.transaction().execute(async (trx) => {
      await expect(
        hook.onRecovered(trx, {
          appId: f.actor.appId,
          userId: f.actor.userId,
          accountId,
          availableBefore: -500n,
          availableAfter,
          voucherId: randomUUID(),
        }),
      ).resolves.toBeUndefined();
      expect(await withdrawalsOf(trx, f.actor.appId)).toEqual(rowsBefore);
    });
    expect(await withdrawalsOf(h.db, f.actor.appId)).toEqual(rowsBefore);
    expect(await books(h.db, f.actor.appId)).toEqual(booksBefore);
  },
);

it.each([0n, 50n])(
  '[AC-B2-05k#4] 本就 ≥0（%s）的会员入账：挂点不被调用，残留的阻断单不动',
  async (start) => {
    const { ledger, hook } = recovering();
    const spy = vi.spyOn(hook, 'onRecovered');
    const f = await setup(h, 100n + start);
    const id = await f.startWithdrawal();
    await seedStatus(f, id, 'APPROVED');
    await block(f, id);
    expect((await balanceOf(f)).available_fen).toBe(start);
    const rowsBefore = await withdrawalsOf(h.db, f.actor.appId);
    const booksBefore = await books(h.db, f.actor.appId);
    const accountId = await accountOf(f);
    const posted = await locked(h.db, ledger, f.actor.appId, [f.actor.userId], (trx) =>
      ledger.post(trx, creditVoucher(f.actor.appId, accountId, 10n)),
    );
    expect(posted.kind).toBe('posted');
    expect(spy).not.toHaveBeenCalled();
    expect(await withdrawalsOf(h.db, f.actor.appId)).toEqual(rowsBefore);
    expect((await balanceOf(f)).available_fen).toBe(start + 10n);
    expectOnlyVoucher(booksBefore, await books(h.db, f.actor.appId), posted.voucherId, 2);
  },
);

it.each(['error', 'sql'] as const)(
  '[AC-B2-05k#5] 挂点在 UPDATE 之后抛错（%s）：整张凭证回滚，余额、分录、凭证、阻断都不变，调用方事务仍可用',
  async (failure) => {
    const { ledger, hook } = recovering();
    const original = hook.onRecovered.bind(hook);
    const thrown = new Error('synthetic recovery port failure');
    let clearedInside: string | null | undefined;
    const f = await setup(h, 200n);
    const approved = await f.startWithdrawal();
    const paying = await f.startWithdrawal();
    await seedStatus(f, approved, 'APPROVED');
    await seedStatus(f, paying, 'PAYING');
    await changeAvailable(f, -1n);
    await block(f, approved);
    await block(f, paying);
    vi.spyOn(hook, 'onRecovered').mockImplementation(async (trx, input) => {
      await original(trx, input);
      clearedInside = (await withdrawal(f, approved, trx)).blocked_reason;
      if (failure === 'error') throw thrown;
      await sql`SELECT 1 / 0`.execute(trx);
    });
    const rowsBefore = await withdrawalsOf(h.db, f.actor.appId);
    const booksBefore = await books(h.db, f.actor.appId);
    const accountId = await accountOf(f);
    const v = creditVoucher(f.actor.appId, accountId, 1n);
    await locked(h.db, ledger, f.actor.appId, [f.actor.userId], async (trx) => {
      const attempt = ledger.post(trx, v);
      if (failure === 'error') await expect(attempt).rejects.toBe(thrown);
      else await expect(attempt).rejects.toThrow();
      // The port's UPDATE ran, then the savepoint undid it with the voucher.
      expect(clearedInside).toBeNull();
      expect(await withdrawalsOf(trx, f.actor.appId)).toEqual(rowsBefore);
      expect(await books(trx, f.actor.appId)).toEqual(booksBefore);
    });
    expect(await withdrawalsOf(h.db, f.actor.appId)).toEqual(rowsBefore);
    expect(await books(h.db, f.actor.appId)).toEqual(booksBefore);
    expect(await balanceOf(f)).toMatchObject({ available_fen: -1n, frozen_fen: 200n });

    // Nothing of the voucher survived: the same uniq_key posts afresh through a working port.
    const { ledger: working, hookClock } = recovering();
    const retried = await locked(h.db, working, f.actor.appId, [f.actor.userId], (trx) =>
      working.post(trx, v),
    );
    expect(retried.kind).toBe('posted');
    expect((await withdrawal(f, approved)).blocked_reason).toBeNull();
    expect((await withdrawal(f, paying)).updated_at).toEqual(hookClock.now());
    expect((await balanceOf(f)).available_fen).toBe(0n);
  },
);

it.each(['no withdrawals', 'only unblocked withdrawals'] as const)(
  '[AC-B2-05k#6] 回正会员没有 NEGATIVE_BALANCE 单（%s）：UPDATE 影响 0 行、不报错，单据 row_version 不变',
  async (kind) => {
    const { ledger, hook } = recovering();
    const spy = vi.spyOn(hook, 'onRecovered');
    const f = await setup(h, kind === 'no withdrawals' ? 0n : 200n);
    if (kind === 'only unblocked withdrawals') {
      await seedStatus(f, await f.startWithdrawal(), 'APPROVED');
      await seedStatus(f, await f.startWithdrawal(), 'PAYING');
    }
    await changeAvailable(f, -1n);
    const rowsBefore = await withdrawalsOf(h.db, f.actor.appId);
    expect(rowsBefore).toHaveLength(kind === 'no withdrawals' ? 0 : 2);
    const booksBefore = await books(h.db, f.actor.appId);
    const accountId = await accountOf(f);
    const posted = await locked(h.db, ledger, f.actor.appId, [f.actor.userId], (trx) =>
      ledger.post(trx, creditVoucher(f.actor.appId, accountId, 1n)),
    );
    expect(posted.kind).toBe('posted');
    expect(spy).toHaveBeenCalledTimes(1);
    await expect(spy.mock.results[0]?.value).resolves.toBeUndefined();
    expect(await withdrawalsOf(h.db, f.actor.appId)).toEqual(rowsBefore);
    expect(await balanceOf(f)).toMatchObject({ available_fen: 0n, negative_since: null });
    expectOnlyVoucher(booksBefore, await books(h.db, f.actor.appId), posted.voucherId, 2);
  },
);
