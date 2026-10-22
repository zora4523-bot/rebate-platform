import { createTestDatabase } from '@couli/db/testing';
// BR-FUND-03、BR-TEXT-09；本任务只读事实，通知方另行筛选正份额与发送。
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { commission, harness, newApp, seedAmounts, seedKey, seedOrder, state } from './kit.ts';

const h = harness(createTestDatabase);

it('[AC-B1-12j#18] 当前版本由各订单行决定，首次版本和后续版本均不硬编码', async () => {
  const app_id = newApp();
  for (const commission_version of [1, 7]) {
    const order = await seedOrder(h.db, app_id, { commission_version });
    const expected = [{ user_id: randomUUID(), role: 'self', amount_fen: 308n }];
    await seedAmounts(h.db, order, commission_version, expected);
    expect(
      await commission.readNotifyBeneficiaries(h.db, { app_id, order_id: order.order_id }),
    ).toEqual(expected);
  }
});

it('[AC-B1-12j#1] 只读 orders 当前版本，保留全部角色和零份额，按 role、user_id 稳定排序', async () => {
  const app_id = newApp();
  const order = await seedOrder(h.db, app_id);
  const [low, high] = [randomUUID(), randomUUID()].sort() as [string, string];
  const people = [
    { user_id: randomUUID(), role: 'share', amount_fen: 1n },
    { user_id: high, role: 'direct', amount_fen: 73n },
    { user_id: randomUUID(), role: 'self', amount_fen: 617n },
    { user_id: randomUUID(), role: 'indirect', amount_fen: 0n },
    { user_id: low, role: 'direct', amount_fen: 123n },
  ];
  await seedAmounts(h.db, order, 1, [{ user_id: randomUUID(), role: 'self', amount_fen: 999n }]);
  await seedAmounts(h.db, order, 2, people);
  // 更高版本和旧版本都不能替代 orders.commission_version。
  await seedAmounts(h.db, order, 3, [{ user_id: randomUUID(), role: 'self', amount_fen: 888n }]);
  const otherOrder = await seedOrder(h.db, app_id);
  await seedAmounts(h.db, otherOrder, 2, [{ user_id: low, role: 'self', amount_fen: 444n }]);
  const before = await state(h.db, app_id);
  const input = { app_id, order_id: order.order_id };
  const expected = [people[4], people[1], people[3], people[2], people[0]];
  expect(await commission.readNotifyBeneficiaries(h.db, input)).toEqual(expected);
  expect(await commission.readNotifyBeneficiaries(h.db, input)).toEqual(expected);
  expect(await state(h.db, app_id)).toEqual(before);
});

it('[AC-B1-12j#2] 金额原样保留 bigint 精度，同一用户不同角色不合并、不按订单佣金重算', async () => {
  const app_id = newApp();
  const order = await seedOrder(h.db, app_id, { est_commission_fen: 1n });
  const user_id = randomUUID();
  const expected = [
    { user_id, role: 'direct', amount_fen: 1n },
    { user_id, role: 'share', amount_fen: 9007199254740993n },
  ];
  await seedAmounts(h.db, order, 2, expected);
  expect(
    await commission.readNotifyBeneficiaries(h.db, { app_id, order_id: order.order_id }),
  ).toEqual(expected);
});

it('[AC-B1-12j#3] 当前版本无快照或版本为零都返回空数组，不回退历史版本', async () => {
  const app_id = newApp();
  for (const version of [0, 2]) {
    const order = await seedOrder(h.db, app_id, { commission_version: version });
    await seedAmounts(h.db, order, 1, [{ user_id: randomUUID(), role: 'self', amount_fen: 22n }]);
    expect(
      await commission.readNotifyBeneficiaries(h.db, { app_id, order_id: order.order_id }),
    ).toEqual([]);
  }
});

it('[AC-B1-12j#4] 订单不存在返回空数组，即使 order_keys 下已有金额行也不返回', async () => {
  const app_id = newApp();
  const key = await seedKey(h.db, app_id);
  await seedAmounts(h.db, key, 1, [{ user_id: randomUUID(), role: 'self', amount_fen: 9n }]);
  expect(
    await commission.readNotifyBeneficiaries(h.db, { app_id, order_id: key.order_id }),
  ).toEqual([]);
  expect(
    await commission.readNotifyBeneficiaries(h.db, { app_id, order_id: randomUUID() }),
  ).toEqual([]);
});

it('[AC-B1-12j#5] app_id 隔离：以另一应用查询同一个真实 order_id 不得泄露受益人', async () => {
  const app_id = newApp();
  const otherApp = newApp();
  const own = await seedOrder(h.db, app_id);
  const foreign = await seedOrder(h.db, otherApp);
  const ownPeople = [{ user_id: randomUUID(), role: 'self', amount_fen: 8n }];
  const foreignPeople = [{ user_id: randomUUID(), role: 'self', amount_fen: 66n }];
  await seedAmounts(h.db, own, 2, ownPeople);
  await seedAmounts(h.db, foreign, 2, foreignPeople);
  // order_keys.order_id 全局唯一；用错误 app 查询已有 ID，不能伪造违反 FK 的跨应用行。
  expect(
    await commission.readNotifyBeneficiaries(h.db, { app_id, order_id: foreign.order_id }),
  ).toEqual([]);
  expect(
    await commission.readNotifyBeneficiaries(h.db, { app_id: otherApp, order_id: own.order_id }),
  ).toEqual([]);
  expect(
    await commission.readNotifyBeneficiaries(h.db, {
      app_id: otherApp,
      order_id: foreign.order_id,
    }),
  ).toEqual(foreignPeople);
});

it('[AC-B1-12j#6] couli_app 只读事务内可读，重复读取不生成快照、不改归属或金额', async () => {
  const app_id = newApp();
  const order = await seedOrder(h.db, app_id);
  const empty = await seedOrder(h.db, app_id);
  const expected = [{ user_id: randomUUID(), role: 'indirect', amount_fen: 0n }];
  await seedAmounts(h.db, order, 2, expected);
  const before = await state(h.db, app_id);
  await h.db
    .transaction()
    .setAccessMode('read only')
    .execute(async (trx) => {
      expect(
        await commission.readNotifyBeneficiaries(trx, { app_id, order_id: order.order_id }),
      ).toEqual(expected);
      expect(
        await commission.readNotifyBeneficiaries(trx, { app_id, order_id: empty.order_id }),
      ).toEqual([]);
      expect(
        await commission.readNotifyBeneficiaries(trx, { app_id, order_id: order.order_id }),
      ).toEqual(expected);
    });
  expect(await state(h.db, app_id)).toEqual(before);
});
