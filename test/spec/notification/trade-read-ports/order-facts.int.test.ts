import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { harness, LONG_TITLE, newApp, orders, seedOrder, seedUser, state } from './kit.ts';

const h = harness();

it('[AC-B1-12j#7] 返回精确的订单事实投影，长标题、归属、订单键和原始佣金不裁剪不换算', async () => {
  const app_id = newApp();
  const user_id = await seedUser(h.db, app_id);
  const row = await seedOrder(h.db, app_id, {
    user_id,
    buy_type: 'share',
    platform: 'taobao',
    platform_status: 'SETTLED',
    est_commission_fen: 9007199254740993n,
  });
  const before = await state(h.db, app_id);
  expect(await orders.readNotifyOrderFacts(h.db, { app_id, order_id: row.order_id })).toEqual({
    order_id: row.order_id,
    platform: 'taobao',
    sub_order_id: row.sub_order_id,
    user_id,
    buy_type: 'share',
    title: LONG_TITLE,
    platform_status: 'SETTLED',
    est_commission_fen: 9007199254740993n,
    commission_version: 2,
  });
  expect(await state(h.db, app_id)).toEqual(before);
});

it('[AC-B1-12j#8] null 与零各自原样保留，不填默认标题、归属、buy_type 或金额', async () => {
  const app_id = newApp();
  for (const amount of [null, 0n]) {
    const row = await seedOrder(h.db, app_id, {
      user_id: null,
      buy_type: null,
      title: null,
      est_commission_fen: amount,
      commission_version: 0,
      platform_status: 'DEPOSIT_PAID',
    });
    expect(await orders.readNotifyOrderFacts(h.db, { app_id, order_id: row.order_id })).toEqual({
      order_id: row.order_id,
      platform: 'jd',
      sub_order_id: row.sub_order_id,
      user_id: null,
      buy_type: null,
      title: null,
      platform_status: 'DEPOSIT_PAID',
      est_commission_fen: amount,
      commission_version: 0,
    });
  }
});

it('[AC-B1-12j#9] 不按通知资格过滤订单，各平台状态与自购事实均可读取', async () => {
  const app_id = newApp();
  const user_id = await seedUser(h.db, app_id);
  for (const platform_status of ['DEPOSIT_PAID', 'PAID', 'RECEIVED', 'SETTLED', 'INVALID']) {
    const row = await seedOrder(h.db, app_id, {
      user_id,
      buy_type: 'self',
      platform_status,
      title: '',
    });
    expect(await orders.readNotifyOrderFacts(h.db, { app_id, order_id: row.order_id })).toEqual({
      order_id: row.order_id,
      platform: 'jd',
      sub_order_id: row.sub_order_id,
      user_id,
      buy_type: 'self',
      title: '',
      platform_status,
      est_commission_fen: 1234n,
      commission_version: 2,
    });
  }
});

it('[AC-B1-12j#10] 不存在或他应用的订单返回 null，不因本应用有其他订单而错配', async () => {
  const app_id = newApp();
  const otherApp = newApp();
  await seedOrder(h.db, app_id);
  const foreign = await seedOrder(h.db, otherApp);
  expect(await orders.readNotifyOrderFacts(h.db, { app_id, order_id: randomUUID() })).toBeNull();
  expect(
    await orders.readNotifyOrderFacts(h.db, { app_id, order_id: foreign.order_id }),
  ).toBeNull();
  expect(
    await orders.readNotifyOrderFacts(h.db, { app_id: otherApp, order_id: foreign.order_id }),
  ).toMatchObject({ order_id: foreign.order_id });
});

it('[AC-B1-12j#11] 只读事务中连续读取订单和缺失订单，不修改任何事实', async () => {
  const app_id = newApp();
  const row = await seedOrder(h.db, app_id);
  const before = await state(h.db, app_id);
  await h.db
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      const input = { app_id, order_id: row.order_id };
      const first = await orders.readNotifyOrderFacts(trx, input);
      expect(first).toMatchObject({
        order_id: row.order_id,
        commission_version: 2,
        est_commission_fen: 1234n,
      });
      expect(await orders.readNotifyOrderFacts(trx, input)).toEqual(first);
      expect(await orders.readNotifyOrderFacts(trx, { app_id, order_id: randomUUID() })).toBeNull();
    });
  expect(await state(h.db, app_id)).toEqual(before);
});
