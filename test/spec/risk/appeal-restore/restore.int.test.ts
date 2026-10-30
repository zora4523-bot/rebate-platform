// B1-03z: a revoked ban appeal registers one appeal_restore difference per sub-order on which the
// member lost shares to this ban (08 BR-CALC-13 细则「申诉恢复」: 「封禁经申诉撤销时，系统为该用户因本次封禁
// forfeited 的份额（forfeit_reason=banned）自动生成『申诉恢复』差错单（BR-FUND-22）…处理前不入账」; 例「U1 入账时
// 封禁，500 归平台；申诉撤销后按 BR-FUND-22 ③ 补发 500」). Attempt 4 (funds review r1): the amount is what the
// share's FORFEIT voucher booked to the platform (S0), ref_id is the order key and one member's roles
// on one sub-order are one difference (S2). Deliveries go straight to the handler on one transaction;
// the queue path is in queue.int.test.ts. Top-level it() only.
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { expectRestore, openSuite, scenario, shortSubOrderId, type Suite } from './db-kit.ts';
import { IN_BAN_1, IN_BAN_2 } from './kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

it('[B1-03z 申诉恢复] 封禁期间被没收 2 份（不同订单、自购与直推）的会员账户申诉撤销 → 恰 2 条 appeal_restore：open、ref_id = 订单键、应恢复额 = 没收凭证金额、实际 0、diff = expected − actual、去重键含 app / 订单 / 用户 / 角色 / 申诉', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const other = await f.user();
  const selfOrder = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  const directOrder = await f.order([
    { userId: other, role: 'self', amountFen: 500n },
    { userId: member, role: 'direct', amountFen: 85n },
  ]);
  await f.forfeit(selfOrder, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  await f.forfeit(directOrder, { userId: member, role: 'direct' }, 'banned', IN_BAN_2);
  const appeal = await f.appeal({ userId: member });
  const before = await f.untouched();

  await f.deliver(f.event(appeal));

  const rows = await f.diffs();
  expect(rows).toHaveLength(2);
  expectRestore(rows[0], f, {
    appealId: appeal.id,
    orderId: directOrder,
    userId: member,
    role: 'direct',
    amountFen: 85n,
  });
  expectRestore(rows[1], f, {
    appealId: appeal.id,
    orderId: selfOrder,
    userId: member,
    role: 'self',
    amountFen: 425n,
  });
  expect(rows[0]?.dedupe_key).not.toBe(rows[1]?.dedupe_key);
  // 处理前不入账: no voucher, entry, balance or share event; the appeal row is not written either.
  expect(await f.untouched()).toEqual(before);
});

it('[B1-03z 申诉恢复金额] 快照预估 425、FORFEIT 凭证实际没收 510 → 差错单应恢复额 510（取凭证记入平台收入的金额，不取快照预估）', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const order = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  await f.forfeit(order, { userId: member, role: 'self' }, 'banned', IN_BAN_1, 510n);
  const appeal = await f.appeal({ userId: member });
  const before = await f.untouched();

  await f.deliver(f.event(appeal));

  const rows = await f.diffs();
  expect(rows).toHaveLength(1);
  expectRestore(rows[0], f, {
    appealId: appeal.id,
    orderId: order,
    userId: member,
    role: 'self',
    amountFen: 510n,
  });
  expect(await f.untouched()).toEqual(before);
});

it('[B1-03z 至少一次投递] 同一 appeal.resolved 重放（同一事件 id 两次、再换新事件 id 一次）不重复登记，原行不被覆盖', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const first = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  const second = await f.order([{ userId: member, role: 'share', amountFen: 300n }]);
  await f.forfeit(first, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  await f.forfeit(second, { userId: member, role: 'share' }, 'banned', IN_BAN_2);
  const appeal = await f.appeal({ userId: member });
  const received = f.event(appeal);

  await f.deliver(received);
  const once = await f.diffs();
  expect(once).toHaveLength(2);
  f.clock.set('2026-09-26T03:00:00.000Z');
  await f.deliver(received);
  await f.deliver({ ...received, attempt: 2 });
  await f.deliver(f.event(appeal, randomUUID()));

  expect(await f.diffs()).toEqual(once);
  expectRestore(once[0], f, {
    appealId: appeal.id,
    orderId: second,
    userId: member,
    role: 'share',
    amountFen: 300n,
  });
  expectRestore(once[1], f, {
    appealId: appeal.id,
    orderId: first,
    userId: member,
    role: 'self',
    amountFen: 425n,
  });
});

it('[B1-03z 申诉恢复] 同一子订单上两位会员（自购与直推）都因封禁被没收、各自申诉撤销（同月结案）→ 各得一条，互不吞并：先登记的 ref_id = 订单键，后登记的用订单键加会员后缀（≤ 64 字符）', async () => {
  const f = await scenario(suite);
  const buyer = await f.user();
  const parent = await f.user();
  const shared = await f.order(
    [
      { userId: buyer, role: 'self', amountFen: 425n },
      { userId: parent, role: 'direct', amountFen: 85n },
    ],
    { subOrderId: shortSubOrderId() },
  );
  await f.forfeit(shared, { userId: buyer, role: 'self' }, 'banned', IN_BAN_1);
  await f.forfeit(shared, { userId: parent, role: 'direct' }, 'banned', IN_BAN_2);
  const buyerAppeal = await f.appeal({ userId: buyer });
  const parentAppeal = await f.appeal({ userId: parent });

  await f.deliver(f.event(buyerAppeal));
  await f.deliver(f.event(parentAppeal));
  // Replays of both appeals register nothing new (the member-specific row is found again too).
  await f.deliver(f.event(parentAppeal, randomUUID()));
  await f.deliver(f.event(buyerAppeal, randomUUID()));

  const rows = await f.diffs();
  expect(rows).toHaveLength(2);
  expectRestore(rows[0], f, {
    appealId: parentAppeal.id,
    orderId: shared,
    userId: parent,
    role: 'direct',
    amountFen: 85n,
    ref: 'member',
  });
  expectRestore(rows[1], f, {
    appealId: buyerAppeal.id,
    orderId: shared,
    userId: buyer,
    role: 'self',
    amountFen: 425n,
  });
  expect(rows[0]?.ref_id).not.toBe(rows[1]?.ref_id);
});

it('[B1-03z 申诉恢复] 同一会员在同一子订单上两个角色（分享与直推）都因封禁被没收 → 合为一条：应恢复额 = 两张凭证之和，去重键含两个角色，resolution.shares 逐角色列明细', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const order = await f.order([
    { userId: member, role: 'share', amountFen: 300n },
    { userId: member, role: 'direct', amountFen: 85n },
  ]);
  await f.forfeit(order, { userId: member, role: 'share' }, 'banned', IN_BAN_1, 310n);
  await f.forfeit(order, { userId: member, role: 'direct' }, 'banned', IN_BAN_1, 90n);
  const appeal = await f.appeal({ userId: member });

  await f.deliver(f.event(appeal));
  await f.deliver(f.event(appeal, randomUUID()));

  const rows = await f.diffs();
  expect(rows).toHaveLength(1);
  expectRestore(rows[0], f, {
    appealId: appeal.id,
    orderId: order,
    userId: member,
    role: ['direct', 'share'],
    amountFen: 400n,
  });
  const resolution = rows[0]?.resolution as { shares?: unknown } | null | undefined;
  expect(resolution?.shares).toHaveLength(2);
  expect(resolution?.shares).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: 'share', amount_fen: '310' }),
      expect.objectContaining({ role: 'direct', amount_fen: '90' }),
    ]),
  );
});

it('[B1-03z 申诉恢复] 差错单只写在消费者事务里：事务回滚后不留差错单，提交后才对其他连接可见', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const order = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  await f.forfeit(order, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  const appeal = await f.appeal({ userId: member });
  const handler = f.handler();
  const abort = new Error('consumer rollback');

  await expect(
    f.db.transaction().execute(async (trx) => {
      await handler(f.event(appeal), trx);
      expect(await f.diffs(trx)).toHaveLength(1);
      expect(await f.diffs()).toEqual([]);
      throw abort;
    }),
  ).rejects.toBe(abort);
  expect(await f.diffs()).toEqual([]);

  await f.db.transaction().execute((trx) => handler(f.event(appeal), trx));
  const rows = await f.diffs();
  expect(rows).toHaveLength(1);
  expectRestore(rows[0], f, {
    appealId: appeal.id,
    orderId: order,
    userId: member,
    role: 'self',
    amountFen: 425n,
  });
});

it('[B1-03z 事件形状] appeal.resolved 数据缺键、类型不符或 app_id 与事件不一致 → 处理器拒绝（队列重试 / 死信），不写差错单', async () => {
  const f = await scenario(suite);
  const member = await f.user();
  const order = await f.order([{ userId: member, role: 'self', amountFen: 425n }]);
  await f.forfeit(order, { userId: member, role: 'self' }, 'banned', IN_BAN_1);
  const appeal = await f.appeal({ userId: member });
  const handler = f.handler();
  const good = f.event(appeal);
  const { appeal_id: _dropped, ...withoutAppeal } = appeal.data;
  void _dropped;
  const bad = [
    { ...good, payload: withoutAppeal },
    { ...good, payload: { ...appeal.data, status: 1 } },
    { ...good, payload: { ...appeal.data, target_type: 'member' } },
    { ...good, payload: { ...appeal.data, app_id: `${f.appId}-other` } },
    { ...good, name: 'risk.state_changed' },
  ];
  const outcomes: string[] = [];
  for (const received of bad) {
    try {
      await f.db.transaction().execute((trx) => handler(received, trx));
      outcomes.push('resolved');
    } catch {
      outcomes.push('rejected');
    }
  }
  expect(outcomes).toEqual(bad.map(() => 'rejected'));
  expect(await f.diffs()).toEqual([]);
});
