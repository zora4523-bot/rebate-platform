import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createWentNegativeConsumer } from '../../../../apps/api/src/modules/payout/application/went-negative.ts';
import { fixture, success } from '../apply/kit.ts';
import {
  setup,
  open,
  close,
  TIMEOUT,
  snapshot,
  withdrawal,
  seedStatus,
  expectReturn,
  invariant,
  negativeEvent,
  changeAvailable,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, 120_000);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-05e#20] AC-S2-08 扣回 300 后两张无尝试的 100 分提现系统驳回，仍欠 100', async () => {
  const f = await setup(h, 200n);
  const logger = { warn: vi.fn() };
  const consumer = createWentNegativeConsumer({ ...f.commandOptions, db: h.db, logger });
  const a = await f.startWithdrawal();
  const b = await f.startWithdrawal();
  await seedStatus(f, b, 'APPROVED');
  await changeAvailable(f, -300n);
  expect((await snapshot(f)).balances[0]).toMatchObject({ available_fen: -300n, frozen_fen: 200n });
  await consumer.consume(negativeEvent(f));
  for (const id of [a, b]) {
    expect(await withdrawal(f, id)).toMatchObject({
      status: 'REJECTED',
      reject_reason_code: 'NEGATIVE_BALANCE',
      reviewer_id: null,
      reject_note: 'system:went_negative',
      reviewed_at: f.clock.now(),
    });
    await expectReturn(f, id, 100n);
  }
  expect((await snapshot(f)).balances[0]).toMatchObject({ available_fen: -100n, frozen_fen: 0n });
  expect(logger.warn).not.toHaveBeenCalled();
  await invariant(f);
});

it.each(['pending', 'success', 'unknown', 'fail'] as const)(
  '[AC-B2-05e#21] APPROVED 有任意 transfer/%s 都只阻断、告警，不自动退款',
  async (result) => {
    const f = await setup(h, 100n);
    const logger = { warn: vi.fn() };
    const consumer = createWentNegativeConsumer({ ...f.commandOptions, db: h.db, logger });
    const id = await f.startWithdrawal();
    await seedStatus(f, id, 'APPROVED');
    f.attempts.set(id, [{ kind: 'transfer', result }]);
    await changeAvailable(f, -1n);
    const before = await snapshot(f);
    await consumer.consume(negativeEvent(f));
    expect(await withdrawal(f, id)).toMatchObject({
      status: 'APPROVED',
      blocked_reason: 'NEGATIVE_BALANCE',
    });
    const after = await snapshot(f);
    expect(after.balances).toEqual(before.balances);
    expect(after.vouchers).toEqual(before.vouchers);
    expect(after.returns).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        app_id: f.actor.appId,
        user_id: f.actor.userId,
        withdrawal_id: id,
      }),
      'withdrawal_blocked_negative',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(f.hmac);
    await invariant(f);
  },
);

it.each(['PENDING_REVIEW', 'APPROVED'] as const)(
  '[AC-B2-05e#22] 系统 W3 对 %s 的失败转账尝试也拒绝',
  async (status) => {
    const f = await setup(h, 100n);
    const commands = f.commands();
    const id = await f.startWithdrawal();
    await seedStatus(f, id, status);
    f.attempts.set(id, [{ kind: 'transfer', result: 'fail' }]);
    await changeAvailable(f, -1n);
    const before = await snapshot(f);
    expect(
      await h.db
        .transaction()
        .execute((trx) => commands.systemRejectNegative(trx, f.command(id, status))),
    ).toEqual({ kind: 'refused', reason: 'attempt_exists' });
    expect(await snapshot(f)).toEqual(before);
  },
);

it('[AC-B2-05e#23] query 记录不是转账尝试，负余额时仍可系统驳回', async () => {
  const f = await setup(h, 100n);
  const consumer = createWentNegativeConsumer({
    ...f.commandOptions,
    db: h.db,
    logger: { warn: vi.fn() },
  });
  const id = await f.startWithdrawal();
  await seedStatus(f, id, 'APPROVED');
  f.attempts.set(id, [{ kind: 'query', result: 'success' }]);
  await changeAvailable(f, -1n);
  await consumer.consume(negativeEvent(f));
  expect((await withdrawal(f, id)).status).toBe('REJECTED');
  expect((await snapshot(f)).balances[0]).toMatchObject({ available_fen: 99n, frozen_fen: 0n });
  await expectReturn(f, id, 100n);
});

it.each([0n, 200n])(
  '[AC-B2-05e#24] 锁内重读已回正到 %s 时只清理阻断（过渡口径）',
  async (balance) => {
    // Task §9.3: consumer recheck is transitional; same-posting-transaction recovery is not claimed.
    const f = await setup(h, 200n);
    const logger = { warn: vi.fn() };
    const consumer = createWentNegativeConsumer({ ...f.commandOptions, db: h.db, logger });
    const pending = await f.startWithdrawal();
    const approved = await f.startWithdrawal();
    await seedStatus(f, approved, 'APPROVED');
    await changeAvailable(f, -1n);
    const event = negativeEvent(f);
    await h.db
      .withSchema('app')
      .updateTable('withdrawals')
      .set({ blocked_reason: 'NEGATIVE_BALANCE' })
      .where('id', '=', approved)
      .execute();
    await changeAvailable(f, 1n + balance);
    const before = await snapshot(f);
    const lock = vi.spyOn(f.commandOptions.ledger, 'lockBalances');
    await consumer.consume(event);
    expect(await withdrawal(f, approved)).toMatchObject({
      status: 'APPROVED',
      blocked_reason: null,
    });
    expect((await withdrawal(f, pending)).status).toBe('PENDING_REVIEW');
    const after = await snapshot(f);
    expect(after.balances).toEqual(before.balances);
    expect(after.vouchers).toEqual(before.vouchers);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(f.commandOptions.lockUsersForUpdate).toHaveBeenCalled();
    expect(lock).toHaveBeenCalled();
    expect(vi.mocked(f.commandOptions.lockUsersForUpdate).mock.invocationCallOrder[0]).toBeLessThan(
      lock.mock.invocationCallOrder[0]!,
    );
  },
);

it('[AC-B2-05e#25] PAYING 不处理，W9 返回 APPROVED 后同一处理任务立即重验并退回', async () => {
  const f = await setup(h, 100n);
  const consumer = createWentNegativeConsumer({
    ...f.commandOptions,
    db: h.db,
    logger: { warn: vi.fn() },
  });
  const id = await f.startWithdrawal();
  await seedStatus(f, id, 'PAYING');
  await changeAvailable(f, -100n);
  const before = await snapshot(f);
  await consumer.consume(negativeEvent(f));
  expect(await snapshot(f)).toEqual(before);
  await seedStatus(f, id, 'APPROVED'); // W9 itself belongs to B2-06.
  await consumer.run(f.actor);
  expect((await withdrawal(f, id)).status).toBe('REJECTED');
  expect((await snapshot(f)).balances[0]).toMatchObject({ available_fen: 0n, frozen_fen: 0n });
  await expectReturn(f, id, 100n);
});

it('[AC-B2-05e#26] 同一 event_id 并发及再次投递只执行一次业务处理', async () => {
  const f = await setup(h, 100n);
  const logger = { warn: vi.fn() };
  const consumer = createWentNegativeConsumer({ ...f.commandOptions, db: h.db, logger });
  const id = await f.startWithdrawal();
  await seedStatus(f, id, 'APPROVED');
  f.attempts.set(id, [{ kind: 'transfer', result: 'unknown' }]);
  await changeAvailable(f, -1n);
  const event = negativeEvent(f);
  await Promise.all([consumer.consume(event), consumer.consume(event)]);
  const once = await snapshot(f);
  await consumer.consume({ ...event, attempt: 2 });
  expect(await snapshot(f)).toEqual(once);
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(
    await h.db
      .withSchema('app')
      .selectFrom('processed_events')
      .selectAll()
      .where('event_id', '=', event.eventId)
      .where('consumer', '=', 'payout-went-negative')
      .execute(),
  ).toHaveLength(1);
});

it('[AC-B2-05e#27] 退款失败回滚消费标记，重投可完成且只有一次退款', async () => {
  const f = await setup(h, 100n);
  const logger = { warn: vi.fn() };
  createWentNegativeConsumer({ ...f.commandOptions, db: h.db, logger });
  const id = await f.startWithdrawal();
  await changeAvailable(f, -1n);
  const event = negativeEvent(f);
  const failure = new Error('synthetic ledger unavailable');
  const consumer = createWentNegativeConsumer({
    ...f.commandOptions,
    db: h.db,
    logger,
    ledger: {
      ...f.ledger,
      post: async () => {
        throw failure;
      },
    },
  });
  const before = await snapshot(f);
  await expect(consumer.consume(event)).rejects.toBe(failure);
  expect(await snapshot(f)).toEqual(before);
  expect(
    await h.db
      .withSchema('app')
      .selectFrom('processed_events')
      .selectAll()
      .where('event_id', '=', event.eventId)
      .execute(),
  ).toHaveLength(0);
  await createWentNegativeConsumer({ ...f.commandOptions, db: h.db, logger }).consume(event);
  expect((await withdrawal(f, id)).status).toBe('REJECTED');
  await expectReturn(f, id, 100n);
});

it('[AC-B2-05e#28] 负余额任务只处理目标 app_id/user_id', async () => {
  const f = await setup(h, 100n);
  const other = await setup(h, 100n);
  const consumer = createWentNegativeConsumer({
    ...f.commandOptions,
    db: h.db,
    logger: { warn: vi.fn() },
  });
  const id = await f.startWithdrawal();
  await other.startWithdrawal();
  await changeAvailable(f, -1n);
  await changeAvailable(other, -1n);
  const before = await snapshot(other);
  await consumer.consume(negativeEvent(f));
  expect((await withdrawal(f, id)).status).toBe('REJECTED');
  expect(await snapshot(other)).toEqual(before);
});

it('[AC-B2-05e#29] 同一 app 的其他负余额用户不能被当前用户的事件驳回', async () => {
  const f = await setup(h, 100n);
  const consumer = createWentNegativeConsumer({
    ...f.commandOptions,
    db: h.db,
    logger: { warn: vi.fn() },
  });
  const sibling = await fixture(h, { appId: f.actor.appId, balance: 100n });
  const id = await f.startWithdrawal();
  const siblingId = success(
    await h.db.transaction().execute((trx) => sibling.apply(trx, 100n)),
  ).withdrawal_id;
  await changeAvailable(f, -1n);
  await changeAvailable(sibling, -1n);
  const before = await withdrawal(sibling, siblingId);
  const selection = { appId: sibling.actor.appId, userIds: [sibling.actor.userId] };
  const balances = await sibling.ledger.getBalances(h.db, selection);
  await consumer.consume(negativeEvent(f));
  expect((await withdrawal(f, id)).status).toBe('REJECTED');
  expect(await withdrawal(sibling, siblingId)).toEqual(before);
  expect(await sibling.ledger.getBalances(h.db, selection)).toEqual(balances);
});
