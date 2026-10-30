import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  LedgerError,
  type BalanceRecoveredHook,
} from '../../../../apps/api/src/modules/ledger/index.ts';
import { change } from '../back-to-nonnegative/kit.ts';
import {
  TIMEOUT,
  account,
  bounded,
  close,
  context,
  deferred,
  expectedLines,
  open,
  post,
  request,
  rewardKey,
  snapshot,
  voucherLines,
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

it('[AC-B2-16b#9] 调用方事务内写入，调用方抛错时一并回滚', async () => {
  const { writer, appId } = context();
  const inviteeId = randomUUID();
  const before = await snapshot(h.db, appId);
  const abort = new Error('caller-abort');
  await expect(
    h.db.transaction().execute(async (trx) => {
      const result = await writer.grant(
        trx,
        request(appId, inviteeId, 'invitee', inviteeId, 1000n),
      );
      expect(result.kind).toBe('posted');
      const inside = await snapshot(trx, appId);
      expect(inside.vouchers.map((v) => v.id)).toEqual([result.voucher_id]);
      expect(inside.balances.map((b) => b.available_fen)).toEqual([1000n]);
      // Nothing of it is visible to another connection before the caller commits.
      expect(await snapshot(h.right, appId)).toEqual(before);
      throw abort;
    }),
  ).rejects.toBe(abort);
  // The opened account, the platform account, the voucher, its entries and the balance row.
  expect(await snapshot(h.db, appId)).toEqual(before);
});

it('[AC-B2-16b#10] 并发同键：后者等前者提交后得 duplicate', async () => {
  const { ledger, writer, appId } = context();
  const inviter = await account(h.db, ledger, appId);
  const inviteeId = randomUUID();
  const input = request(appId, inviteeId, 'inviter', inviter.user_id, 1000n);
  const gate = deferred<void>();
  const leftGranted = deferred<number>();
  const rightStarted = deferred<number>();
  const left = h.left.transaction().execute(async (trx) => {
    const pid = await bounded(trx);
    const result = await writer.grant(trx, input);
    leftGranted.resolve(pid);
    await gate.promise;
    return result;
  });
  let right: Promise<unknown> | undefined;
  try {
    const holder = await Promise.race([
      leftGranted.promise,
      left.then(() => expect.fail('left committed before the gate')),
    ]);
    const second = h.right.transaction().execute(async (trx) => {
      rightStarted.resolve(await bounded(trx));
      return writer.grant(trx, { ...input, amount_fen: 777n });
    });
    right = second;
    const waiter = await Promise.race([
      rightStarted.promise,
      second.then(() => expect.fail('right finished before it started')),
    ]);
    // A real server-side wait on the first writer, never a sleep.
    await waitBlocked(h.control, waiter, holder);
  } finally {
    gate.resolve();
  }
  const first = await left;
  expect(first.kind).toBe('posted');
  expect(await right).toEqual({ kind: 'duplicate', voucher_id: first.voucher_id });
  const state = await snapshot(h.db, appId);
  expect(state.vouchers).toHaveLength(1);
  expect(state.vouchers[0]).toMatchObject({
    id: first.voucher_id,
    uniq_key: rewardKey(inviteeId, 'inviter'),
  });
  expect(state.entries).toHaveLength(2);
  expect(await ledger.getBalances(h.db, { appId, userIds: [inviter.user_id] })).toEqual([
    { ...inviter, available_fen: 1000n, version: 1n },
  ]);
});

it('[AC-B2-16b#11] 负余额入奖励回正，经同一 ledger 的回正端口', async () => {
  const onRecovered = vi.fn<BalanceRecoveredHook['onRecovered']>(() => Promise.resolve());
  const { ledger, writer, appId } = context({ hook: { onRecovered } });
  const inviter = await account(h.db, ledger, appId);
  // A clawback of 300 fen leaves available at -300 (BR-FUND-10 allows it for CLAWBACK).
  await post(h.db, ledger, [inviter.user_id], change(appId, inviter.account_id, 300n));
  const [negative] = await ledger.getBalances(h.db, { appId, userIds: [inviter.user_id] });
  expect(negative).toMatchObject({ available_fen: -300n, version: 1n });
  expect(negative?.negative_since).not.toBeNull();
  expect(onRecovered).not.toHaveBeenCalled();

  const inviteeId = randomUUID();
  const result = await h.db
    .transaction()
    .execute((trx) =>
      writer.grant(trx, request(appId, inviteeId, 'inviter', inviter.user_id, 1000n)),
    );
  expect(result.kind).toBe('posted');
  // The balance moved through the given ledger's post: its recovery port saw this voucher.
  expect(onRecovered).toHaveBeenCalledTimes(1);
  expect(onRecovered).toHaveBeenCalledWith(expect.anything(), {
    appId,
    userId: inviter.user_id,
    accountId: inviter.account_id,
    availableBefore: -300n,
    availableAfter: 700n,
    voucherId: result.voucher_id,
  });
  const state = await snapshot(h.db, appId);
  expect(voucherLines(state, result.voucher_id!)).toEqual(
    expectedLines(inviter.user_id, 1000n, 700n, 2n),
  );
  expect(await ledger.getBalances(h.db, { appId, userIds: [inviter.user_id] })).toEqual([
    { ...inviter, available_fen: 700n, version: 2n, negative_since: null },
  ]);
});

it.each(['negative-amount', 'inviter-is-invitee', 'invitee-paid-to-other'] as const)(
  '[AC-B2-16b#12] 拒绝 %s：INVALID_INPUT，零写入且事务可继续',
  async (kind) => {
    const { ledger, writer, appId } = context();
    const inviter = await account(h.db, ledger, appId);
    const inviteeId = randomUUID();
    const valid = request(appId, inviteeId, 'inviter', inviter.user_id, 1000n);
    const bad =
      kind === 'negative-amount'
        ? { ...valid, amount_fen: -1n }
        : kind === 'inviter-is-invitee'
          ? { ...valid, user_id: inviteeId }
          : { ...valid, party: 'invitee' as const };
    const result = await h.db.transaction().execute(async (trx) => {
      const before = await snapshot(trx, appId);
      const error = await writer.grant(trx, bad).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(LedgerError);
      expect(error).toMatchObject({ code: 'INVALID_INPUT' });
      expect(await snapshot(trx, appId)).toEqual(before);
      return writer.grant(trx, valid);
    });
    expect(result.kind).toBe('posted');
    const state = await snapshot(h.db, appId);
    expect(state.vouchers.map((v) => v.uniq_key)).toEqual([rewardKey(inviteeId, 'inviter')]);
    expect(await ledger.getBalances(h.db, { appId, userIds: [inviter.user_id] })).toEqual([
      { ...inviter, available_fen: 1000n, version: 1n },
    ]);
  },
);
