import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '@couli/db/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createClaimResultMessageHandler } from '../../../../apps/api/src/modules/notification/application/claim-result-message.ts';
import { seedAmounts, seedClaim, seedItem, seedOrder, state } from '../trade-read-ports/kit.ts';
import { failInsert, fixture, NOW, openSuite, type Suite } from './db-kit.ts';

let suite: Suite;
beforeAll(async () => {
  suite = await openSuite(createTestDatabase);
});
afterAll(async () => {
  await suite?.close();
});

it('[AC-B1-12r#6] approved 只加通过条目当前版本的申请人份额，排除上级、其他状态与其他找回单，原业务表不变', async () => {
  const f = await fixture(suite);
  await f.item(1n);
  await f.item(989n);
  await f.item(5000n, 'rejected');
  await f.item(6000n, 'cancelled');
  await f.item(7000n, null);
  const unrelated = await seedClaim(f.db, f.appId, { user_id: f.userId, status: 'approved' });
  const order = await seedOrder(f.db, f.appId);
  await seedItem(f.db, unrelated, {
    order_id: order.order_id,
    sub_order_id: order.sub_order_id,
    decision: 'approved',
    decided_at: f.clock.now(),
  });
  await seedAmounts(f.db, order, 2, [{ user_id: f.userId, role: 'self', amount_fen: 8000n }]);
  const before = await state(f.db, f.appId);
  const event = f.event();
  await f.deliver(event);
  const rows = await f.rows();
  expect(rows.inbox).toMatchObject([
    {
      app_id: f.appId,
      user_id: f.userId,
      code: 'CLAIM_RESULT',
      title: '找回结果',
      body: '订单找回成功，预估返 ¥9.9',
      route: null,
      read_at: null,
      created_at: new Date(NOW),
      updated_at: new Date(NOW),
    },
  ]);
  expect(rows.logs).toMatchObject([
    {
      app_id: f.appId,
      user_id: f.userId,
      code: 'CLAIM_RESULT',
      channel: 'inbox',
      status: 'success',
      dedupe_key: `claim.resolved:${event.eventId}`,
      sent_at: new Date(NOW),
      planned_at: new Date(NOW),
    },
  ]);
  expect(await state(f.db, f.appId)).toEqual(before);
});

it.each([
  [0n, '订单找回成功，预估返 ¥0'],
  [9007199254740993n, '订单找回成功，预估返 ¥90071992547409.93'],
] as const)(
  '[AC-B1-12r#7] 持久化金额 %s 不经浮点、不改用订单预估或历史分佣',
  async (amount, body) => {
    const f = await fixture(suite);
    await f.item(amount);
    await f.deliver(f.event());
    expect((await f.rows()).inbox).toMatchObject([{ body }]);
  },
);

it.each([
  ['NO_EVIDENCE', '订单找回未通过：没有找到这笔订单经凑狸下单的记录'],
  ['NOT_IN_POOL', '订单找回未通过：该订单已由平台记录归属，找回已关闭'],
  ['ORDER_INVALID', '订单找回未通过：暂无法找回该订单，请联系客服'],
] as const)(
  '[AC-B1-12r#8] rejected / %s 通知申请人，不取订单归属人或审核备注',
  async (reason, body) => {
    const f = await fixture(suite, 'rejected');
    await f.item(700n, 'rejected', reason);
    await f.deliver(f.event());
    expect((await f.rows()).inbox).toMatchObject([
      { user_id: f.userId, title: '找回结果', body, route: null },
    ]);
    expect((await f.rows()).logs).toMatchObject([
      { user_id: f.userId, code: 'CLAIM_RESULT', channel: 'inbox', status: 'success' },
    ]);
  },
);

it.each(['cancelled', 'submitted', 'auto_matched', 'manual_review', 'future_status'])(
  '[AC-B1-12r#9] 载荷状态 %s 不发且不写日志，不被数据库中的 approved 覆盖',
  async (status) => {
    const f = await fixture(suite);
    await f.item(123n);
    await f.deliver(f.event({ status }));
    expect(await f.rows()).toEqual({ inbox: [], logs: [] });
  },
);

it.each([
  ['approved', '预计到账前可查看：¥3.21'],
  ['rejected', '未通过：没有找到这笔订单经凑狸下单的记录'],
] as const)(
  '[AC-B1-12r#10] %s 按 app/code/variant 读取覆盖，覆盖不扩展渠道和路由',
  async (status, body) => {
    const f = await fixture(suite, status);
    const foreign = await fixture(suite, status);
    await f.item(321n, status);
    await foreign.template(status, { title_override: '其他应用', body_override: '其他应用正文' });
    await f.template(status === 'approved' ? 'rejected' : 'approved', {
      title_override: '另一变体',
      body_override: '另一变体正文',
    });
    await f.template(status, {
      title_override: '结果更新',
      body_override: status === 'approved' ? '预计到账前可查看：{rebate}' : '未通过：{reason}',
      category: 'marketing',
      channels: ['push', 'sms'],
      route: { route: 'wallet', params: {} },
    });
    await f.deliver(f.event());
    expect((await f.rows()).inbox).toMatchObject([{ title: '结果更新', body, route: null }]);
    expect((await f.rows()).logs).toMatchObject([{ channel: 'inbox', status: 'success' }]);
  },
);

it('[AC-B1-12r#11] 无本变体覆盖时用默认，其他 app、code、variant 不串用', async () => {
  const f = await fixture(suite);
  const foreign = await fixture(suite);
  await f.item(100n);
  await foreign.template('approved', { title_override: '外部', body_override: '外部正文' });
  await f.template('rejected', { title_override: '驳回', body_override: '驳回正文' });
  await f.template('approved', {
    code: 'ORDER_TRACKED',
    title_override: '跟单',
    body_override: '跟单正文',
  });
  await f.deliver(f.event());
  expect((await f.rows()).inbox).toMatchObject([
    { title: '找回结果', body: '订单找回成功，预估返 ¥1' },
  ]);
});

it('[AC-B1-12r#12] 同一事件串行及并发投递始终只有一条信与日志，不依赖 processed_events', async () => {
  const f = await fixture(suite);
  await f.item(321n);
  const event = f.event();
  // Concurrent first deliveries exercise the PG unique boundary rather than only a pre-read.
  await Promise.all(Array.from({ length: 4 }, () => f.deliver(event)));
  const before = await f.rows();
  f.clock.advanceMs(60_000);
  await f.deliver({ ...event, attempt: 2 });
  expect(before.inbox).toHaveLength(1);
  expect(before.logs).toHaveLength(1);
  expect(await f.rows()).toEqual(before);
});

it('[AC-B1-12r#13] 相同找回单不同事件编号各发一次；同编号跨 app 不互相去重', async () => {
  const a = await fixture(suite);
  const b = await fixture(suite);
  await a.item(100n);
  await b.item(200n);
  const first = a.event();
  await a.deliver(first);
  await a.deliver(a.event());
  await b.deliver({ ...b.event(), eventId: first.eventId });
  expect((await a.rows()).inbox).toHaveLength(2);
  expect((await a.rows()).logs).toHaveLength(2);
  expect((await b.rows()).inbox).toMatchObject([
    { user_id: b.userId, body: '订单找回成功，预估返 ¥2' },
  ]);
  expect((await b.rows()).logs).toMatchObject([{ dedupe_key: `claim.resolved:${first.eventId}` }]);
});

it('[AC-B1-12r#14] 已有通知日志时不补发、不覆写日志', async () => {
  const f = await fixture(suite);
  await f.item(321n);
  const event = f.event();
  await f.log(event);
  const before = await f.rows();
  await f.deliver(event);
  expect(await f.rows()).toEqual(before);
});

it.each(['inbox_messages', 'notify_logs'] as const)(
  '[AC-B1-12r#15] %s 写入失败两张表一起回滚，重投可以成功',
  async (table) => {
    const f = await fixture(suite);
    await f.item(321n);
    const event = f.event();
    const fault = failInsert(table);
    // Build outside the rejection assertion: skeleton errors cannot accidentally satisfy it.
    const handler = createClaimResultMessageHandler({ clock: f.clock });
    await expect(
      f.db
        .withPlugin(fault.plugin)
        .transaction()
        .execute((trx) => handler(event, trx)),
    ).rejects.toMatchObject({ code: '22012' });
    expect(fault.fired()).toBe(true);
    expect(await f.rows()).toEqual({ inbox: [], logs: [] });
    await f.deliver(event);
    expect((await f.rows()).inbox).toHaveLength(1);
    expect((await f.rows()).logs).toHaveLength(1);
  },
);

it('[AC-B1-12r#16] 调用方事务后续失败时通知也回滚，不另开事务提前提交', async () => {
  const f = await fixture(suite);
  await f.item(321n);
  const handler = createClaimResultMessageHandler({ clock: f.clock });
  await expect(
    f.db.transaction().execute(async (trx) => {
      await handler(f.event(), trx);
      throw new Error('synthetic transaction abort');
    }),
  ).rejects.toThrow('synthetic transaction abort');
  expect(await f.rows()).toEqual({ inbox: [], logs: [] });
});

it('[AC-B1-12r#17] 载荷引用另一 app 的找回单时不能读出条目、金额或发信', async () => {
  const f = await fixture(suite);
  const foreign = await fixture(suite);
  await foreign.item(999999n);
  const handler = createClaimResultMessageHandler({ clock: f.clock });
  // Missing tenant-scoped facts may reject the job or ignore it, but must never notify anyone.
  await f.db
    .transaction()
    .execute((trx) => handler(f.event({ claim_id: foreign.claim.id }), trx))
    .catch(() => undefined);
  expect(await f.rows()).toEqual({ inbox: [], logs: [] });
  expect(await foreign.rows()).toEqual({ inbox: [], logs: [] });
});

it('[AC-B1-12r#18] 事件 app 与载荷 app 不一致必须失败且不写通知', async () => {
  const f = await fixture(suite);
  const foreign = await fixture(suite);
  const handler = createClaimResultMessageHandler({ clock: f.clock });
  await expect(
    f.db.transaction().execute((trx) => handler(f.event({ app_id: foreign.appId }), trx)),
  ).rejects.toThrow();
  expect(await f.rows()).toEqual({ inbox: [], logs: [] });
  expect(await foreign.rows()).toEqual({ inbox: [], logs: [] });
});

it('[AC-B1-12r#19] 当前版本无本人份额不回退旧版本、不使用订单归属人份额', async () => {
  const f = await fixture(suite);
  const order = await seedOrder(f.db, f.appId, { user_id: f.otherUser });
  await seedItem(f.db, f.claim, {
    order_id: order.order_id,
    sub_order_id: order.sub_order_id,
    decision: 'approved',
    decided_at: f.clock.now(),
  });
  await seedAmounts(f.db, order, 1, [{ user_id: f.userId, role: 'self', amount_fen: 9900n }]);
  await seedAmounts(f.db, order, 2, [{ user_id: f.otherUser, role: 'self', amount_fen: 8800n }]);
  await f.deliver({ ...f.event(), eventId: randomUUID() });
  expect((await f.rows()).inbox).toMatchObject([
    { user_id: f.userId, body: '订单找回成功，预估返 ¥0' },
  ]);
});

it('[AC-B1-12r#25] rejected 跳过排在前面的 cancelled 条目，取驳回条目的原因', async () => {
  const f = await fixture(suite, 'rejected');
  await seedItem(f.db, f.claim, {
    decision: 'cancelled',
    reject_reason: null,
    decided_at: f.clock.now(),
    created_at: new Date('2026-10-20T03:04:05.000Z'),
  });
  await seedItem(f.db, f.claim, {
    decision: 'rejected',
    reject_reason: 'NO_EVIDENCE',
    decided_at: f.clock.now(),
    created_at: new Date('2026-10-20T03:04:06.000Z'),
  });
  await f.deliver(f.event());
  const rows = await f.rows();
  expect(rows.inbox).toMatchObject([
    {
      user_id: f.userId,
      code: 'CLAIM_RESULT',
      body: '订单找回未通过：没有找到这笔订单经凑狸下单的记录',
    },
  ]);
  expect(rows.logs).toMatchObject([
    { user_id: f.userId, code: 'CLAIM_RESULT', channel: 'inbox', status: 'success' },
  ]);
});

it('[AC-B1-12r#26] 多个驳回原因按 created_at、id 升序取第一条，不按插入顺序或仅按 id', async () => {
  const f = await fixture(suite, 'rejected');
  const ids: [string, string, string] = [randomUUID(), randomUUID(), randomUUID()];
  ids.sort();
  // 最小 id 的条目创建时间较晚；两个较早条目同一时刻创建，较小 id 最后插入。
  await seedItem(f.db, f.claim, {
    id: ids[0],
    decision: 'rejected',
    reject_reason: 'NOT_IN_POOL',
    decided_at: f.clock.now(),
    created_at: new Date('2026-10-20T03:04:06.000Z'),
  });
  await seedItem(f.db, f.claim, {
    id: ids[2],
    decision: 'rejected',
    reject_reason: 'NOT_IN_POOL',
    decided_at: f.clock.now(),
    created_at: new Date('2026-10-20T03:04:05.000Z'),
  });
  await seedItem(f.db, f.claim, {
    id: ids[1],
    decision: 'rejected',
    reject_reason: 'NO_EVIDENCE',
    decided_at: f.clock.now(),
    created_at: new Date('2026-10-20T03:04:05.000Z'),
  });
  await f.deliver(f.event());
  const rows = await f.rows();
  expect(rows.inbox).toMatchObject([
    {
      user_id: f.userId,
      code: 'CLAIM_RESULT',
      body: '订单找回未通过：没有找到这笔订单经凑狸下单的记录',
    },
  ]);
  expect(rows.logs).toMatchObject([
    { user_id: f.userId, code: 'CLAIM_RESULT', channel: 'inbox', status: 'success' },
  ]);
});
