import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { lockUsersForUpdate } from '../../../../apps/api/src/modules/identity/ports/lock-users.ts';
import { createWithdrawHolds } from '../../../../apps/api/src/modules/payout/application/withdraw-holds.ts';
import { createWithdrawalInFlightReader } from '../../../../apps/api/src/modules/payout/application/withdrawal-in-flight.ts';
import {
  setup,
  open,
  close,
  TIMEOUT,
  snapshot,
  seedStatus,
  withdrawal,
  seedUser,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-05e#30] 多原因冻结叠加、逐条解除并记录审计和注入时钟', async () => {
  const f = await setup(h);
  const audit = { append: vi.fn(async () => undefined) };
  const holds = createWithdrawHolds({ clock: f.clock, lockUsersForUpdate, audit });
  const id = await f.startWithdrawal();
  const before = await snapshot(f);
  const added: string[] = [];
  for (const reason of [
    'manual',
    'recon_diff',
    'ledger_mismatch',
    'manual_failed_watch',
  ] as const) {
    const result = await h.db.transaction().execute((trx) =>
      holds.add(trx, {
        ...f.actor,
        reason,
        sourceRef: 'synthetic-case',
        createdBy: f.reviewerId,
        holdUntil: null,
      }),
    );
    added.push(result.id);
    expect(audit.append).toHaveBeenLastCalledWith(
      expect.objectContaining({
        appId: f.actor.appId,
        actor: f.reviewerId,
        action: 'withdraw_hold.add',
        target: result.id,
      }),
    );
  }
  const all = (await snapshot(f)).holds;
  expect(all).toHaveLength(4);
  expect(
    all.every(
      (row) =>
        row.created_at.getTime() === f.clock.now().getTime() &&
        row.released_at === null &&
        row.released_by === null &&
        row.source_ref === 'synthetic-case',
    ),
  ).toBe(true);
  f.clock.set('2026-10-20T02:00:00.000Z');
  await h.db
    .transaction()
    .execute((trx) => holds.release(trx, { holdId: added[0]!, releasedBy: f.reviewerId }));
  expect(audit.append).toHaveBeenLastCalledWith(
    expect.objectContaining({
      appId: f.actor.appId,
      actor: f.reviewerId,
      action: 'withdraw_hold.release',
      target: added[0],
    }),
  );
  const after = await snapshot(f);
  expect(after.holds.find((row) => row.id === added[0])).toMatchObject({
    released_at: f.clock.now(),
    released_by: f.reviewerId,
  });
  expect(after.holds.filter((row) => row.id !== added[0])).toEqual(
    all.filter((row) => row.id !== added[0]),
  );
  expect(after.withdrawals).toEqual(before.withdrawals);
  expect(after.balances).toEqual(before.balances);
  expect((await withdrawal(f, id)).status).toBe('PENDING_REVIEW');
  expect(audit.append).toHaveBeenCalledTimes(5);
});

it.each(['add', 'release'] as const)(
  '[AC-B2-05e#31] %s 修改前先锁 users，其他事务不能同时取得同一用户锁',
  async (operation) => {
    const f = await setup(h);
    const holdId = randomUUID();
    const audit = { append: vi.fn(async () => undefined) };
    const lock = vi.fn<typeof lockUsersForUpdate>(async (trx, input) => {
      expect(input).toEqual({ appId: f.actor.appId, userIds: [f.actor.userId] });
      expect((await snapshot(f, trx)).holds).toEqual(before.holds);
      const locked = await lockUsersForUpdate(trx, input);
      await expect(
        h.observer.transaction().execute(async (other) => {
          await sql`SELECT id FROM app.users WHERE app_id=${f.actor.appId} AND id=${f.actor.userId} FOR UPDATE NOWAIT`.execute(
            other,
          );
        }),
      ).rejects.toMatchObject({ code: '55P03' });
      return locked;
    });
    const holds = createWithdrawHolds({ clock: f.clock, lockUsersForUpdate: lock, audit });
    await h.db
      .withSchema('app')
      .insertInto('withdraw_holds')
      .values({
        id: holdId,
        app_id: f.actor.appId,
        user_id: f.actor.userId,
        reason: 'manual',
        created_by: f.reviewerId,
      })
      .execute();
    const before = await snapshot(f);
    await h.db.transaction().execute(async (trx) => {
      if (operation === 'add')
        await holds.add(trx, {
          ...f.actor,
          reason: 'recon_diff',
          sourceRef: null,
          createdBy: f.reviewerId,
          holdUntil: null,
        });
      else await holds.release(trx, { holdId, releasedBy: f.reviewerId });
      expect(await snapshot(f, h.observer)).toEqual(before);
    });
    expect(lock).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledTimes(1);
  },
);

it.each(['add', 'release'] as const)(
  '[AC-B2-05e#32] %s 审计失败不能留下冻结变更',
  async (operation) => {
    const f = await setup(h);
    const failure = new Error('synthetic audit failure');
    const holds = createWithdrawHolds({
      clock: f.clock,
      lockUsersForUpdate,
      audit: {
        append: async () => {
          throw failure;
        },
      },
    });
    const holdId = randomUUID();
    await h.db
      .withSchema('app')
      .insertInto('withdraw_holds')
      .values({
        id: holdId,
        app_id: f.actor.appId,
        user_id: f.actor.userId,
        reason: 'manual',
        created_by: f.reviewerId,
      })
      .execute();
    const before = await snapshot(f);
    await expect(
      h.db.transaction().execute(async (trx) => {
        if (operation === 'add')
          await holds.add(trx, {
            ...f.actor,
            reason: 'manual',
            sourceRef: null,
            createdBy: f.reviewerId,
            holdUntil: null,
          });
        else await holds.release(trx, { holdId, releasedBy: f.reviewerId });
      }),
    ).rejects.toBe(failure);
    expect(await snapshot(f)).toEqual(before);
  },
);

it.each([
  'PENDING_REVIEW',
  'APPROVED',
  'PAYING',
  'REJECTED',
  'PAID_API',
  'PAID_MANUAL',
  'FAILED',
] as const)('[AC-B2-05e#33] 在途与非终态 reader 的 %s 边界、租户和用户隔离', async (status) => {
  const f = await setup(h);
  const reader = createWithdrawalInFlightReader({ clock: f.clock });
  const id = await f.startWithdrawal();
  await seedStatus(f, id, status);
  const otherUser = await seedUser(h.db, f.actor.appId);
  const before = await snapshot(f);
  await h.db.transaction().execute(async (trx) => {
    const active = ['PENDING_REVIEW', 'APPROVED', 'PAYING'].includes(status);
    expect(await reader.hasInFlight(trx, f.actor)).toBe(active);
    expect(await reader.hasNonTerminal(trx, f.actor)).toBe(active);
    for (const input of [
      { ...f.actor, appId: 'other-app' },
      { ...f.actor, userId: otherUser },
    ]) {
      expect(await reader.hasInFlight(trx, input)).toBe(false);
      expect(await reader.hasNonTerminal(trx, input)).toBe(false);
    }
  });
  expect(await snapshot(f)).toEqual(before);
});

it.each([
  { reason: 'manual', until: null, released: false, blocked: true },
  { reason: 'manual', until: '2026-10-19T02:00:00.001Z', released: false, blocked: true },
  { reason: 'manual', until: '2026-10-19T02:00:00.000Z', released: false, blocked: false },
  { reason: 'manual', until: '2026-10-19T01:59:59.999Z', released: false, blocked: false },
  { reason: 'manual', until: null, released: true, blocked: false },
  { reason: 'recon_diff', until: null, released: false, blocked: false },
  { reason: 'ledger_mismatch', until: null, released: false, blocked: false },
  { reason: 'manual_failed_watch', until: null, released: false, blocked: false },
])(
  '[AC-B2-05e#34] hold $reason/$until/released=$released 只影响在途口径',
  async ({ reason, until, released, blocked }) => {
    const f = await setup(h);
    const reader = createWithdrawalInFlightReader({ clock: f.clock });
    await f.startWithdrawal();
    const before = await snapshot(f);
    await h.db.transaction().execute(async (trx) => {
      await trx
        .withSchema('app')
        .insertInto('withdraw_holds')
        .values({
          id: randomUUID(),
          app_id: f.actor.appId,
          user_id: f.actor.userId,
          reason,
          created_by: f.reviewerId,
          hold_until: until === null ? null : new Date(until),
          released_at: released ? f.clock.now() : null,
          released_by: released ? f.reviewerId : null,
        })
        .execute();
      expect(await reader.hasInFlight(trx, f.actor)).toBe(!blocked);
      expect(await reader.hasNonTerminal(trx, f.actor)).toBe(true);
      expect(await snapshot(f, h.observer)).toEqual(before); // Reads must see caller's uncommitted hold.
    });
  },
);

it.each(['frozen', 'banned', 'appealing'] as const)(
  '[AC-B2-05e#35] %s 和生效 hold 都不影响 W2/W3',
  async (risk) => {
    const f = await setup(h);
    const commands = f.commands();
    const id = await f.startWithdrawal();
    await h.db
      .withSchema('app')
      .insertInto('user_risk_state')
      .values({
        app_id: f.actor.appId,
        user_id: f.actor.userId,
        state: risk,
        changed_at: f.clock.now(),
        changed_by: 'synthetic',
        reason_category: 'other',
      })
      .onConflict((oc) => oc.columns(['app_id', 'user_id']).doUpdateSet({ state: risk }))
      .execute();
    await h.db
      .withSchema('app')
      .insertInto('withdraw_holds')
      .values({
        id: randomUUID(),
        app_id: f.actor.appId,
        user_id: f.actor.userId,
        reason: 'manual',
        created_by: f.reviewerId,
      })
      .execute();
    expect(await h.db.transaction().execute((trx) => commands.approve(trx, f.command(id)))).toEqual(
      { kind: 'changed', status: 'APPROVED' },
    );
    expect(
      await h.db.transaction().execute((trx) =>
        commands.reject(trx, {
          ...f.command(id, 'APPROVED', 1),
          reasonCode: 'USER_REQUEST',
          note: null,
        }),
      ),
    ).toEqual({ kind: 'changed', status: 'REJECTED' });
    expect((await snapshot(f)).balances[0]).toMatchObject({
      available_fen: 10000n,
      frozen_fen: 0n,
    });
  },
);
