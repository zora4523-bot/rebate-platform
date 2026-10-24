import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  close,
  isPaid,
  open,
  seedStatus,
  seedUser,
  setup,
  snapshot,
  STATUSES,
  succeededReader,
  TIMEOUT,
  type Harness,
  type Status,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each(STATUSES)(
  '[AC-B1-27j#1] 单笔 %s：只有 PAID_API / PAID_MANUAL 为真，租户与用户隔离，只读',
  async (status) => {
    const f = await setup(h);
    const reader = succeededReader(f.clock);
    const id = await f.startWithdrawal();
    await seedStatus(f, id, status);
    const otherUser = await seedUser(h.db, f.actor.appId);
    const before = await snapshot(f);
    await h.db.transaction().execute(async (trx) => {
      expect(await reader.hasSucceeded(trx, f.actor)).toBe(isPaid(status));
      for (const input of [
        { ...f.actor, appId: 'other-app' },
        { ...f.actor, userId: otherUser },
      ]) {
        expect(await reader.hasSucceeded(trx, input)).toBe(false);
      }
    });
    expect(await snapshot(f)).toEqual(before);
  },
);

it('[AC-B1-27j#2] 没有任何提现的用户为假', async () => {
  const f = await setup(h);
  const reader = succeededReader(f.clock);
  const before = await snapshot(f);
  expect(await h.db.transaction().execute((trx) => reader.hasSucceeded(trx, f.actor))).toBe(false);
  expect(await snapshot(f)).toEqual(before);
});

it.each<{ statuses: Status[]; succeeded: boolean }>([
  { statuses: ['FAILED', 'REJECTED', 'PAYING'], succeeded: false },
  { statuses: ['REJECTED', 'APPROVED', 'PENDING_REVIEW'], succeeded: false },
  { statuses: ['FAILED', 'PAID_MANUAL'], succeeded: true },
  { statuses: ['PAID_API', 'PENDING_REVIEW'], succeeded: true },
  { statuses: ['PAID_API', 'PAID_MANUAL', 'FAILED'], succeeded: true },
])('[AC-B1-27j#3] 多笔 $statuses：任一笔到账即为真', async ({ statuses, succeeded }) => {
  const f = await setup(h);
  const reader = succeededReader(f.clock);
  for (const status of statuses) {
    const id = await f.startWithdrawal();
    await seedStatus(f, id, status);
  }
  const before = await snapshot(f);
  expect(before.withdrawals).toHaveLength(statuses.length);
  expect(await h.db.transaction().execute((trx) => reader.hasSucceeded(trx, f.actor))).toBe(
    succeeded,
  );
  expect(await snapshot(f)).toEqual(before);
});

it.each(['PAID_API', 'PAID_MANUAL'] as const)(
  '[AC-B1-27j#4] 在调用方事务上读：未提交的 %s 可见，回滚后为假',
  async (status) => {
    const f = await setup(h);
    const reader = succeededReader(f.clock);
    const id = await f.startWithdrawal();
    const before = await snapshot(f);
    const rollback = new Error('synthetic rollback');
    await expect(
      h.db.transaction().execute(async (trx) => {
        expect(await reader.hasSucceeded(trx, f.actor)).toBe(false);
        await trx
          .withSchema('app')
          .updateTable('withdrawals')
          .set({
            status,
            paid_at: f.clock.now(),
            manual_entry_by: status === 'PAID_MANUAL' ? randomUUID() : null,
            manual_confirm_by: status === 'PAID_MANUAL' ? randomUUID() : null,
          })
          .where('app_id', '=', f.actor.appId)
          .where('id', '=', id)
          .execute();
        expect(await reader.hasSucceeded(trx, f.actor)).toBe(true);
        expect(await snapshot(f, h.observer)).toEqual(before);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect(await h.db.transaction().execute((trx) => reader.hasSucceeded(trx, f.actor))).toBe(
      false,
    );
    expect(await snapshot(f)).toEqual(before);
  },
);

it.each(STATUSES)('[AC-B1-27j#5] %s：冻结记录与收款身份不影响成功提现口径', async (status) => {
  const f = await setup(h);
  const reader = succeededReader(f.clock);
  // Another payee identity on the row (BR-ID-25: 不分身份) and holds of every reason in effect.
  // payee_name is not updatable by the app role, so the apply snapshot port fixes it at creation.
  const payee = f.options.snapshot;
  f.options.snapshot = {
    async read(handle, who) {
      const row = await payee.read(handle, who);
      return row && { ...row, payee_name: '另一合成姓名' };
    },
  };
  const id = await f.startWithdrawal();
  await seedStatus(f, id, status);
  for (const reason of [
    'manual',
    'recon_diff',
    'ledger_mismatch',
    'manual_failed_watch',
  ] as const) {
    await h.db
      .withSchema('app')
      .insertInto('withdraw_holds')
      .values({
        id: randomUUID(),
        app_id: f.actor.appId,
        user_id: f.actor.userId,
        reason,
        created_by: f.reviewerId,
      })
      .execute();
  }
  const before = await snapshot(f);
  expect(await h.db.transaction().execute((trx) => reader.hasSucceeded(trx, f.actor))).toBe(
    isPaid(status),
  );
  expect(await snapshot(f)).toEqual(before);
});
