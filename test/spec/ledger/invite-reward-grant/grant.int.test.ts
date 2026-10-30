import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { voucher } from '../posting/kit.ts';
import {
  TIMEOUT,
  account,
  accountingDays,
  close,
  context,
  expectedLines,
  open,
  post,
  request,
  rewardKey,
  snapshot,
  userOwners,
  voucherLines,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

// specs/ledger-templates.csv 252–253 (REWARD:INVITE), specs/ledger-rules.md §3 / §4.10.
it('[AC-B2-16b#1] 邀请人一方：借 MKT_EXPENSE、贷 available，键 :inviter', async () => {
  const { ledger, writer, appId } = context();
  const inviter = await account(h.db, ledger, appId);
  const inviteeId = randomUUID();
  const result = await h.db
    .transaction()
    .execute((trx) =>
      writer.grant(trx, request(appId, inviteeId, 'inviter', inviter.user_id, 1000n)),
    );
  expect(result.kind).toBe('posted');
  expect(typeof result.voucher_id).toBe('string');
  const state = await snapshot(h.db, appId);
  expect(state.vouchers).toHaveLength(1);
  expect(state.vouchers[0]).toMatchObject({
    id: result.voucher_id,
    app_id: appId,
    uniq_key: rewardKey(inviteeId, 'inviter'),
    // Not tied to an order (BR-INV-24 ⑤, BR-FUND-01): the key carries no order_key.
    order_key: null,
  });
  expect(voucherLines(state, result.voucher_id!)).toEqual(
    expectedLines(inviter.user_id, 1000n, 1000n, 1n),
  );
  expect(state.entries).toHaveLength(2);
  // Only the beneficiary's account: the inviter's voucher opens no account for the invitee.
  expect(userOwners(state)).toEqual([inviter.user_id]);
  expect(await ledger.getBalances(h.db, { appId, userIds: [inviter.user_id] })).toEqual([
    { ...inviter, available_fen: 1000n, version: 1n },
  ]);
});

it('[AC-B2-16b#2] 被邀请人一方：账户不存在先开户再入账，键 :invitee', async () => {
  const { ledger, writer, appId } = context();
  const inviteeId = randomUUID();
  const before = await snapshot(h.db, appId);
  expect(userOwners(before)).toEqual([]);
  const result = await h.db
    .transaction()
    .execute((trx) => writer.grant(trx, request(appId, inviteeId, 'invitee', inviteeId, 1000n)));
  expect(result.kind).toBe('posted');
  const state = await snapshot(h.db, appId);
  expect(userOwners(state)).toEqual([inviteeId]);
  expect(state.accounts.filter((a) => a.owner_type === 'user')[0]).toMatchObject({
    owner_id: inviteeId,
    subject: 'USER_BALANCE',
  });
  expect(state.vouchers).toHaveLength(1);
  expect(state.vouchers[0]).toMatchObject({
    id: result.voucher_id,
    uniq_key: rewardKey(inviteeId, 'invitee'),
    order_key: null,
  });
  expect(voucherLines(state, result.voucher_id!)).toEqual(
    expectedLines(inviteeId, 1000n, 1000n, 1n),
  );
  const [balance] = await ledger.getBalances(h.db, { appId, userIds: [inviteeId] });
  expect(balance).toMatchObject({
    user_id: inviteeId,
    available_fen: 1000n,
    frozen_fen: 0n,
    version: 1n,
    negative_since: null,
  });
});

it('[AC-B2-16b#3] 同一事务两方各一张凭证，各自余额加 reward_fen', async () => {
  const { ledger, writer, appId } = context();
  const inviter = await account(h.db, ledger, appId);
  const inviteeId = randomUUID();
  const [first, second] = await h.db.transaction().execute(async (trx) => {
    const a = await writer.grant(trx, request(appId, inviteeId, 'inviter', inviter.user_id, 1000n));
    const b = await writer.grant(trx, request(appId, inviteeId, 'invitee', inviteeId, 1000n));
    return [a, b] as const;
  });
  expect(first.kind).toBe('posted');
  expect(second.kind).toBe('posted');
  expect(first.voucher_id).not.toBe(second.voucher_id);
  const state = await snapshot(h.db, appId);
  expect(state.vouchers.map((v) => v.uniq_key).sort()).toEqual(
    [rewardKey(inviteeId, 'invitee'), rewardKey(inviteeId, 'inviter')].sort(),
  );
  expect(state.entries).toHaveLength(4);
  // BR-FUND-16: every voucher sums to zero.
  for (const v of state.vouchers) {
    const sum = state.entries
      .filter((e) => e.voucher_id === v.id)
      .reduce((total, e) => total + e.amount_fen, 0n);
    expect(sum).toBe(0n);
  }
  expect(voucherLines(state, first.voucher_id!)).toEqual(
    expectedLines(inviter.user_id, 1000n, 1000n, 1n),
  );
  expect(voucherLines(state, second.voucher_id!)).toEqual(
    expectedLines(inviteeId, 1000n, 1000n, 1n),
  );
  // One MKT_EXPENSE platform account carries both debits.
  const platform = state.accounts.filter((a) => a.owner_type === 'platform');
  expect(platform).toHaveLength(1);
  expect(platform[0]).toMatchObject({ owner_id: 'platform', subject: 'MKT_EXPENSE' });
  expect(
    state.entries
      .filter((e) => e.account_id === platform[0]!.id)
      .reduce((total, e) => total + e.amount_fen, 0n),
  ).toBe(2000n);
  const balances = await ledger.getBalances(h.db, {
    appId,
    userIds: [inviter.user_id, inviteeId],
  });
  expect(balances.map((b) => [b.user_id, b.available_fen, b.version]).sort()).toEqual(
    [
      [inviter.user_id, 1000n, 1n],
      [inviteeId, 1000n, 1n],
    ].sort(),
  );
});

it('[AC-B2-16b#4] 同键重放返回原 voucher_id，不追加分录、不改余额', async () => {
  const { ledger, writer, appId } = context();
  const inviter = await account(h.db, ledger, appId);
  const inviteeId = randomUUID();
  const input = request(appId, inviteeId, 'inviter', inviter.user_id, 1000n);
  const first = await h.db.transaction().execute((trx) => writer.grant(trx, input));
  expect(first.kind).toBe('posted');
  const before = await snapshot(h.db, appId);
  expect(before.vouchers).toHaveLength(1);
  expect(await h.db.transaction().execute((trx) => writer.grant(trx, input))).toEqual({
    kind: 'duplicate',
    voucher_id: first.voucher_id,
  });
  // A replay with another amount is still the booked business event.
  expect(
    await h.db.transaction().execute((trx) => writer.grant(trx, { ...input, amount_fen: 999n })),
  ).toEqual({ kind: 'duplicate', voucher_id: first.voucher_id });
  expect(await snapshot(h.db, appId)).toEqual(before);

  // Same transaction: the second call is a replay of the first.
  const otherInvitee = randomUUID();
  const again = request(appId, otherInvitee, 'inviter', inviter.user_id, 500n);
  const [x, y] = await h.db.transaction().execute(async (trx) => {
    const a = await writer.grant(trx, again);
    const b = await writer.grant(trx, again);
    return [a, b] as const;
  });
  expect(x.kind).toBe('posted');
  expect(y).toEqual({ kind: 'duplicate', voucher_id: x.voucher_id });
  const after = await snapshot(h.db, appId);
  expect(after.vouchers).toHaveLength(2);
  expect(after.entries).toHaveLength(4);
  expect(await ledger.getBalances(h.db, { appId, userIds: [inviter.user_id] })).toEqual([
    { ...inviter, available_fen: 1500n, version: 2n },
  ]);
});

it('[AC-B2-16b#5] 键只按被邀请人与受益方区分', async () => {
  const { ledger, writer, appId } = context();
  const inviter = await account(h.db, ledger, appId);
  const inviteeA = randomUUID();
  const inviteeB = randomUUID();
  // The same inviter is paid once per invitee; the invitee's side never takes the inviter's key.
  const a = await h.db
    .transaction()
    .execute((trx) =>
      writer.grant(trx, request(appId, inviteeA, 'inviter', inviter.user_id, 1000n)),
    );
  const b = await h.db
    .transaction()
    .execute((trx) =>
      writer.grant(trx, request(appId, inviteeB, 'inviter', inviter.user_id, 800n)),
    );
  const c = await h.db
    .transaction()
    .execute((trx) => writer.grant(trx, request(appId, inviteeA, 'invitee', inviteeA, 1000n)));
  expect([a.kind, b.kind, c.kind]).toEqual(['posted', 'posted', 'posted']);
  expect(new Set([a.voucher_id, b.voucher_id, c.voucher_id]).size).toBe(3);
  const state = await snapshot(h.db, appId);
  expect(state.vouchers.map((v) => v.uniq_key).sort()).toEqual(
    [
      rewardKey(inviteeA, 'inviter'),
      rewardKey(inviteeB, 'inviter'),
      rewardKey(inviteeA, 'invitee'),
    ].sort(),
  );
  expect(voucherLines(state, b.voucher_id!)).toEqual(
    expectedLines(inviter.user_id, 800n, 1800n, 2n),
  );
  expect(await ledger.getBalances(h.db, { appId, userIds: [inviter.user_id] })).toEqual([
    { ...inviter, available_fen: 1800n, version: 2n },
  ]);
});

it('[AC-B2-16b#6] reward_fen 为 0 不出凭证、不占键', async () => {
  const { ledger, writer, appId } = context();
  const inviter = await account(h.db, ledger, appId);
  const inviteeId = randomUUID();
  const before = await snapshot(h.db, appId);
  const zero = await h.db
    .transaction()
    .execute((trx) => writer.grant(trx, request(appId, inviteeId, 'inviter', inviter.user_id, 0n)));
  expect(zero).toEqual({ kind: 'zero', voucher_id: null });
  expect(await snapshot(h.db, appId)).toEqual(before);
  // The key stays free: a later positive amount under it is booked as usual.
  const paid = await h.db
    .transaction()
    .execute((trx) =>
      writer.grant(trx, request(appId, inviteeId, 'inviter', inviter.user_id, 1000n)),
    );
  expect(paid.kind).toBe('posted');
  const state = await snapshot(h.db, appId);
  expect(state.vouchers).toHaveLength(1);
  expect(state.vouchers[0]).toMatchObject({
    id: paid.voucher_id,
    uniq_key: rewardKey(inviteeId, 'inviter'),
  });
});

it('[AC-B2-16b#7] 已有余额经 ledger 累加，balance_after 与版本接续', async () => {
  const { ledger, writer, appId } = context();
  const inviter = await account(h.db, ledger, appId);
  // A credit of 50 fen booked earlier through the ledger itself.
  await post(h.db, ledger, [inviter.user_id], voucher(appId, inviter.account_id, -50n));
  const inviteeId = randomUUID();
  const result = await h.db
    .transaction()
    .execute((trx) =>
      writer.grant(trx, request(appId, inviteeId, 'inviter', inviter.user_id, 1000n)),
    );
  expect(result.kind).toBe('posted');
  const state = await snapshot(h.db, appId);
  expect(voucherLines(state, result.voucher_id!)).toEqual(
    expectedLines(inviter.user_id, 1000n, 1050n, 2n),
  );
  expect(await ledger.getBalances(h.db, { appId, userIds: [inviter.user_id] })).toEqual([
    { ...inviter, available_fen: 1050n, version: 2n },
  ]);
});

it.each([
  ['2032-06-15T15:59:59.999Z', '2032-06-15'],
  ['2032-06-15T16:00:00.000Z', '2032-06-16'],
])('[AC-B2-16b#8] Clock %s 定 booked_at 与 +08:00 会计日 %s', async (instant, day) => {
  // The FixedClock is years away from the database clock: a SQL now() would show here.
  const { ledger, writer, appId } = context({ instant });
  const inviter = await account(h.db, ledger, appId);
  const inviteeId = randomUUID();
  const result = await h.db
    .transaction()
    .execute((trx) =>
      writer.grant(trx, request(appId, inviteeId, 'inviter', inviter.user_id, 1000n, instant)),
    );
  expect(result.kind).toBe('posted');
  const state = await snapshot(h.db, appId);
  expect(state.entries.map((e) => e.booked_at.toISOString())).toEqual([instant, instant]);
  expect(await accountingDays(h.db, appId)).toEqual([day]);
});
