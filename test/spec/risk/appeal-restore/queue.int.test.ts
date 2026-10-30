// B1-03z through the real worker registration (task brief 9.2 ①④): the handler AppModule registers
// on `evt.risk-appeal-restore` consumes appeal.resolved jobs at least once — a repeated delivery
// registers nothing new, a failed registration rolls back with the processed_events row and the
// retry succeeds, an event it ignores is still acknowledged. Attempt 4 (funds review S0): the real
// assembly reads each share's forfeited amount from its FORFEIT voucher in the ledger (the fixture
// writes real ledger_vouchers / ledger_entries rows), so it must inject the ledger read; an
// assembly without it refuses every revoked ban appeal and these cases stay red. Top-level it() only.
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { expectRestore, failInsert, openSuite, scenario, type Suite } from './db-kit.ts';
import { CONSUMER, IN_BAN_1, IN_BAN_2, QUEUE, job } from './kit.ts';
import { assembled, handlersOf } from './worker-kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

async function processed(eventId: string) {
  return suite.db
    .selectFrom('processed_events')
    .select(['consumer', 'event_id'])
    .where('event_id', '=', eventId)
    .execute();
}

it('[B1-03z 队列] worker 实际注册的处理器消费撤销事件：登记 2 条，重复投递不再登记，processed_events 记一行，不发任何任务', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const first = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  const second = await f.order([{ userId: member, role: 'direct', amountFen: 85n }]);
  await f.forfeit(first, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  await f.forfeit(second, { userId: member, role: 'direct' }, 'banned', IN_BAN_2);
  const appeal = await f.appeal({ userId: member });
  const received = f.event(appeal);
  const app = await assembled('worker', f.db, f.clock);
  try {
    const handlers = handlersOf(app, QUEUE);
    expect(handlers).toHaveLength(1);
    await handlers[0]!(job(received));
    await handlers[0]!(job({ ...received, attempt: 2 }));
    const rows = await f.diffs();
    expect(rows).toHaveLength(2);
    expectRestore(rows[0], f, {
      appealId: appeal.id,
      orderId: second,
      userId: member,
      role: 'direct',
      amountFen: 85n,
    });
    expectRestore(rows[1], f, {
      appealId: appeal.id,
      orderId: first,
      userId: member,
      role: 'self',
      amountFen: 425n,
    });
    expect(await processed(received.eventId)).toEqual([
      { consumer: CONSUMER, event_id: received.eventId },
    ]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it('[B1-03z 队列] worker 实际注册的处理器按 FORFEIT 凭证金额登记：快照预估 425、实际没收 510 → 应恢复额 510，ref_id = 订单键', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const order = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  await f.forfeit(order, { userId: member, role: 'self' }, 'banned', IN_BAN_1, 510n);
  const appeal = await f.appeal({ userId: member });
  const received = f.event(appeal);
  const app = await assembled('worker', f.db, f.clock);
  try {
    const handlers = handlersOf(app, QUEUE);
    expect(handlers).toHaveLength(1);
    await handlers[0]!(job(received));
    const rows = await f.diffs();
    expect(rows).toHaveLength(1);
    expectRestore(rows[0], f, {
      appealId: appeal.id,
      orderId: order,
      userId: member,
      role: 'self',
      amountFen: 510n,
    });
    expect(await processed(received.eventId)).toEqual([
      { consumer: CONSUMER, event_id: received.eventId },
    ]);
  } finally {
    await app.close();
  }
});

it('[B1-03z 队列] 登记差错单失败时整笔回滚（无差错单、无 processed_events），队列重投后恰好登记一次', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const first = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  const second = await f.order([{ userId: member, role: 'direct', amountFen: 85n }]);
  await f.forfeit(first, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  await f.forfeit(second, { userId: member, role: 'direct' }, 'banned', IN_BAN_2);
  const appeal = await f.appeal({ userId: member });
  const received = f.event(appeal);

  const fault = failInsert('recon_diffs');
  const failing = await assembled('worker', f.db.withPlugin(fault.plugin), f.clock);
  try {
    const handlers = handlersOf(failing, QUEUE);
    expect(handlers).toHaveLength(1);
    await expect(handlers[0]!(job(received))).rejects.toMatchObject({ code: '22012' });
    expect(fault.fired()).toBe(true);
    expect(await f.diffs()).toEqual([]);
    expect(await processed(received.eventId)).toEqual([]);
  } finally {
    await failing.close();
  }

  const recovered = await assembled('worker', f.db, f.clock);
  try {
    const handlers = handlersOf(recovered, QUEUE);
    expect(handlers).toHaveLength(1);
    await handlers[0]!(job({ ...received, attempt: 2 }));
    expect(await f.diffs()).toHaveLength(2);
    expect(await processed(received.eventId)).toEqual([
      { consumer: CONSUMER, event_id: received.eventId },
    ]);
  } finally {
    await recovered.close();
  }
});

it('[B1-03z 队列] 不处理的结案（封禁申诉维持）由实际处理器确认：processed_events 记一行，不写差错单', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const order = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  await f.forfeit(order, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  const appeal = await f.appeal({ userId: member, status: 'upheld' });
  const received = f.event(appeal);
  const app = await assembled('worker', f.db, f.clock);
  try {
    const handlers = handlersOf(app, QUEUE);
    expect(handlers).toHaveLength(1);
    await handlers[0]!(job(received));
    expect(await f.diffs()).toEqual([]);
    expect(await processed(received.eventId)).toEqual([
      { consumer: CONSUMER, event_id: received.eventId },
    ]);
    expect(app.sends).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
