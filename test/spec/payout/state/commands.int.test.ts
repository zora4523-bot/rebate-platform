import { createTestDatabase } from '@couli/db/testing';
import * as domain from '@couli/domain';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  WithdrawalConflictError,
  type RejectWithdrawalCommand,
} from '../../../../apps/api/src/modules/payout/application/withdrawal-commands.ts';
import {
  setup,
  open,
  close,
  TIMEOUT,
  changeAvailable,
  snapshot,
  withdrawal,
  seedStatus,
  expectReturn,
  invariant,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it.each([0n, 1n])(
  '[AC-B2-05e#1] W2 available=%s 通过、无分录，锁 users 后锁余额',
  async (available) => {
    const f = await setup(h, 100n + available);
    const commands = f.commands();
    const id = await f.startWithdrawal();
    const before = await snapshot(f);
    const lock = vi.spyOn(f.commandOptions.ledger, 'lockBalances');
    const result = await h.db.transaction().execute(async (trx) => {
      const answer = await commands.approve(trx, f.command(id));
      expect((await withdrawal(f, id, trx)).status).toBe('APPROVED');
      expect(await snapshot(f, h.observer)).toEqual(before);
      return answer;
    });
    expect(result).toEqual({ kind: 'changed', status: 'APPROVED' });
    expect(await withdrawal(f, id)).toMatchObject({
      row_version: 1,
      reviewer_id: f.reviewerId,
      reviewed_at: f.clock.now(),
      amount_fen: 100n,
      fee_fen: 0n,
      tax_fen: 0n,
      net_fen: 100n,
    });
    const after = await snapshot(f);
    expect(after.vouchers).toEqual(before.vouchers);
    expect(after.balances).toEqual(before.balances);
    expect(after.events).toHaveLength(before.events.length + 1);
    expect(
      after.events.filter((e) => e.name === 'wallet.withdrawal_changed').at(-1)?.payload,
    ).toEqual({ v: 1, data: { withdrawal_id: id, user_id: f.actor.userId, status: 'APPROVED' } });
    expect(f.commandOptions.lockUsersForUpdate).toHaveBeenCalledWith(expect.anything(), {
      appId: f.actor.appId,
      userIds: [f.actor.userId],
    });
    expect(lock).toHaveBeenCalled();
    expect(vi.mocked(f.commandOptions.lockUsersForUpdate).mock.invocationCallOrder[0]).toBeLessThan(
      lock.mock.invocationCallOrder[0]!,
    );
    await invariant(f);
  },
);

it.each(['negative_balance', 'blocked'] as const)(
  '[AC-B2-05e#2] W2 %s 拒绝且无副作用',
  async (reason) => {
    const f = await setup(h, 100n);
    const commands = f.commands();
    const id = await f.startWithdrawal();
    if (reason === 'negative_balance') await changeAvailable(f, -1n);
    else
      await h.db
        .withSchema('app')
        .updateTable('withdrawals')
        .set({ blocked_reason: 'NEGATIVE_BALANCE' })
        .where('id', '=', id)
        .execute();
    const before = await snapshot(f);
    expect(await h.db.transaction().execute((trx) => commands.approve(trx, f.command(id)))).toEqual(
      { kind: 'refused', reason },
    );
    expect(await snapshot(f)).toEqual(before);
  },
);

it.each(['PENDING_REVIEW', 'APPROVED'] as const)(
  '[AC-B2-05e#3] W3 %s 驳回同事务全额退回',
  async (status) => {
    const f = await setup(h);
    const commands = f.commands();
    const id = await f.startWithdrawal(1200n);
    if (status === 'APPROVED') await seedStatus(f, id, status);
    const before = await snapshot(f);
    await h.db.transaction().execute(async (trx) => {
      expect(
        await commands.reject(trx, {
          ...f.command(id, status),
          reasonCode: 'USER_REQUEST',
          note: '合成备注',
        }),
      ).toEqual({ kind: 'changed', status: 'REJECTED' });
      const inside = await snapshot(f, trx);
      expect(inside.withdrawals[0]).toMatchObject({
        status: 'REJECTED',
        row_version: 1,
        reject_reason_code: 'USER_REQUEST',
        reject_note: '合成备注',
      });
      expect(inside.returns).toHaveLength(2);
      expect(inside.balances[0]).toMatchObject({ available_fen: 10000n, frozen_fen: 0n });
      expect(inside.events).toHaveLength(before.events.length + 1);
      expect(await snapshot(f, h.observer)).toEqual(before);
    });
    await expectReturn(f, id, 1200n);
    const after = await snapshot(f);
    expect(
      after.events.filter((e) => e.name === 'wallet.withdrawal_changed').at(-1)?.payload,
    ).toEqual({ v: 1, data: { withdrawal_id: id, user_id: f.actor.userId, status: 'REJECTED' } });
    expect(await withdrawal(f, id)).toMatchObject({
      reviewer_id: f.reviewerId,
      reviewed_at: f.clock.now(),
    });
    await invariant(f);
  },
);

it.each([undefined, null, '', 'NOT_A_REASON'])(
  '[AC-B2-05e#4] W3 非法原因 %s 不改变资金与状态',
  async (reasonCode) => {
    const f = await setup(h);
    const commands = f.commands();
    const id = await f.startWithdrawal();
    const before = await snapshot(f);
    const input = {
      ...f.command(id),
      reasonCode,
      note: null,
    } as unknown as RejectWithdrawalCommand;
    expect(await h.db.transaction().execute((trx) => commands.reject(trx, input))).toEqual({
      kind: 'refused',
      reason: 'reason_required',
    });
    expect(await snapshot(f)).toEqual(before);
  },
);

it.each(['pending', 'success', 'unknown'] as const)(
  '[AC-B2-05e#5] APPROVED 有 transfer/%s 时人工驳回被拒绝',
  async (result) => {
    const f = await setup(h);
    const commands = f.commands();
    const id = await f.startWithdrawal();
    await seedStatus(f, id, 'APPROVED');
    f.attempts.set(id, [{ kind: 'transfer', result }]);
    const before = await snapshot(f);
    expect(
      await h.db.transaction().execute((trx) =>
        commands.reject(trx, {
          ...f.command(id, 'APPROVED'),
          reasonCode: 'OTHER',
          note: '人工复核',
        }),
      ),
    ).toEqual({ kind: 'refused', reason: 'attempt_exists' });
    expect(await snapshot(f)).toEqual(before);
  },
);

it.each(['fail', 'query'] as const)(
  '[AC-B2-05e#6] 普通 APPROVED 的 %s 记录不误拦人工 W3',
  async (attempt) => {
    const f = await setup(h);
    const commands = f.commands();
    const id = await f.startWithdrawal();
    await seedStatus(f, id, 'APPROVED');
    f.attempts.set(id, [
      {
        kind: attempt === 'query' ? 'query' : 'transfer',
        result: attempt === 'query' ? 'success' : 'fail',
      },
    ]);
    expect(
      await h.db.transaction().execute((trx) =>
        commands.reject(trx, {
          ...f.command(id, 'APPROVED'),
          reasonCode: 'OTHER',
          note: '人工复核',
        }),
      ),
    ).toEqual({ kind: 'changed', status: 'REJECTED' });
    await expectReturn(f, id, 100n);
  },
);

it('[AC-B2-05e#7] 同版本并发驳回只有一个成功，另一个 20902，RETURN 只有一张', async () => {
  const f = await setup(h);
  const commands = f.commands();
  const id = await f.startWithdrawal();
  const input = { ...f.command(id), reasonCode: 'USER_REQUEST' as const, note: null };
  const results = await Promise.allSettled([
    h.db.transaction().execute((trx) => commands.reject(trx, input)),
    h.observer.transaction().execute((trx) => commands.reject(trx, input)),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toEqual([
    { status: 'fulfilled', value: { kind: 'changed', status: 'REJECTED' } },
  ]);
  const rejected = results.filter((r) => r.status === 'rejected');
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toBeInstanceOf(WithdrawalConflictError);
  expect(rejected[0]?.reason).toMatchObject({ code: 20902, data: { resource: 'withdrawal' } });
  await expectReturn(f, id, 100n);
  expect((await snapshot(f)).events).toHaveLength(3);
  await invariant(f);
});

it('[AC-B2-05e#8] 状态相同但版本过期也必须 CAS 冲突且不写分录', async () => {
  const f = await setup(h);
  const commands = f.commands();
  const id = await f.startWithdrawal();
  await h.db
    .withSchema('app')
    .updateTable('withdrawals')
    .set({ row_version: 1 })
    .where('id', '=', id)
    .execute();
  const before = await snapshot(f);
  await expect(
    h.db.transaction().execute((trx) =>
      commands.reject(trx, {
        ...f.command(id),
        reasonCode: 'OTHER',
        note: null,
      }),
    ),
  ).rejects.toMatchObject({ code: 20902, data: { resource: 'withdrawal' } });
  expect(await snapshot(f)).toEqual(before);
});

it.each(['REJECTED', 'PAID_API', 'PAID_MANUAL', 'FAILED', 'PAYING'] as const)(
  '[AC-B2-05e#9] %s 不允许 W2/W3，金额和状态均不变',
  async (status) => {
    const f = await setup(h);
    const commands = f.commands();
    const id = await f.startWithdrawal();
    await seedStatus(f, id, status);
    const before = await snapshot(f);
    for (const operation of ['approve', 'reject'] as const) {
      const answer = await h.db
        .transaction()
        .execute((trx) =>
          operation === 'approve'
            ? commands.approve(trx, f.command(id, status))
            : commands.reject(trx, { ...f.command(id, status), reasonCode: 'OTHER', note: null }),
        );
      expect(answer).toEqual({ kind: 'refused', reason: 'invalid_state' });
    }
    expect(await snapshot(f)).toEqual(before);
  },
);

it.each(['post', 'event', 'caller'] as const)(
  '[AC-B2-05e#10] %s 故障回滚状态、退回分录和事件',
  async (fault) => {
    const f = await setup(h);
    f.commands(); // Do not swallow the skeleton exception in the expected failure below.
    const id = await f.startWithdrawal();
    const before = await snapshot(f);
    const failure = new Error('synthetic rollback');
    if (fault === 'post')
      f.commandOptions.ledger = {
        ...f.ledger,
        post: async () => {
          throw failure;
        },
      };
    if (fault === 'event')
      f.commandOptions.eventBus = {
        publish: async () => {
          throw failure;
        },
      };
    const commands = f.commands();
    await expect(
      h.db.transaction().execute(async (trx) => {
        await commands.reject(trx, { ...f.command(id), reasonCode: 'OTHER', note: null });
        if (fault === 'caller') throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await snapshot(f)).toEqual(before);
  },
);

it('[AC-B2-05e#11] app_id 错配不得迁移别的租户的提现', async () => {
  const f = await setup(h);
  const commands = f.commands();
  const id = await f.startWithdrawal();
  const before = await snapshot(f);
  await expect(
    h.db.transaction().execute((trx) =>
      commands.reject(trx, {
        ...f.command(id),
        appId: 'another-app',
        reasonCode: 'OTHER',
        note: null,
      }),
    ),
  ).rejects.toMatchObject({ code: 20902, data: { resource: 'withdrawal' } });
  expect(await snapshot(f)).toEqual(before);
});

it('[AC-B2-05e#12] W2/W3 通过生成的 transitionWithdrawal 决定迁移', async () => {
  const f = await setup(h);
  const commands = f.commands();
  const id = await f.startWithdrawal();
  const transition = vi.spyOn(domain, 'transitionWithdrawal');
  try {
    expect(await h.db.transaction().execute((trx) => commands.approve(trx, f.command(id)))).toEqual(
      { kind: 'changed', status: 'APPROVED' },
    );
    expect(
      transition.mock.calls.some(
        ([from, event]) => from === 'PENDING_REVIEW' && event === 'APPROVE',
      ),
    ).toBe(true);
    transition.mockClear();
    expect(
      await h.db.transaction().execute((trx) =>
        commands.reject(trx, {
          ...f.command(id, 'APPROVED', 1),
          reasonCode: 'USER_REQUEST',
          note: null,
        }),
      ),
    ).toEqual({ kind: 'changed', status: 'REJECTED' });
    expect(
      transition.mock.calls.some(([from, event]) => from === 'APPROVED' && event === 'REJECT'),
    ).toBe(true);
  } finally {
    transition.mockRestore();
  }
});

it.each(['RISK_SUSPECT', 'ORDER_ABNORMAL', 'PAYEE_INFO_INVALID', 'USER_REQUEST', 'OTHER'] as const)(
  '[AC-B2-05e#13] 人工原因码 %s 按契约保存',
  async (reasonCode) => {
    const f = await setup(h);
    const commands = f.commands();
    const id = await f.startWithdrawal();
    expect(
      await h.db.transaction().execute((trx) =>
        commands.reject(trx, {
          ...f.command(id),
          reasonCode,
          note: '合成原因说明',
        }),
      ),
    ).toEqual({ kind: 'changed', status: 'REJECTED' });
    expect((await withdrawal(f, id)).reject_reason_code).toBe(reasonCode);
    await expectReturn(f, id, 100n);
  },
);
