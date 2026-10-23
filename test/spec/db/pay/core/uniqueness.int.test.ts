import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import {
  anomaly,
  fulfillment,
  harness,
  insert,
  notification,
  order,
  person,
  ready,
  refund,
  rejects,
  scenario,
  update,
} from './kit.ts';

const h = harness(createTestDatabase);

it('[AC-B2-15a#6] 支付单号在同 app 内跨业务与渠道唯一，关闭也不释放单号', async () => {
  const db = h.db();
  await ready(db);
  const { p, o } = await scenario(db);
  for (const status of ['PENDING', 'PAID', 'CLOSED']) {
    await rejects(
      insert(
        db,
        'pay_orders',
        order(p, { out_trade_no: o['out_trade_no'], status, pay_channel: 'alipay' }),
      ),
      '23505',
    );
  }
  await update(db, 'pay_orders', o, { status: 'CLOSED' });
  await rejects(insert(db, 'pay_orders', order(p, { out_trade_no: o['out_trade_no'] })), '23505');
  // 单号的全局生成规则属业务层；这里只验证明确要求的 (app_id, out_trade_no) 数据库键。
  const other = await person(db);
  expect(
    (await insert(db, 'pay_orders', order(other, { out_trade_no: o['out_trade_no'] }))).rows,
  ).toHaveLength(1);
});

it('[AC-B2-15a#7] PENDING 和 PAID 都占用业务唯一键，CLOSED 释放且重新激活会冲突', async () => {
  const db = h.db();
  await ready(db);
  const { p, o } = await scenario(db);
  const key = { biz_type: o['biz_type'], biz_ref: o['biz_ref'] };
  for (const status of ['PENDING', 'PAID']) {
    await rejects(
      insert(db, 'pay_orders', order(p, { ...key, status, pay_channel: 'alipay' })),
      '23505',
    );
  }
  const otherUser = await person(db, p.app_id);
  await rejects(insert(db, 'pay_orders', order(otherUser, key)), '23505');
  await update(db, 'pay_orders', o, { status: 'PAID' });
  await rejects(insert(db, 'pay_orders', order(p, key)), '23505');
  // 只测试部分索引成员资格，不把这里的 SQL 当作业务状态迁移实现。
  const closed = order(p, { ...key, status: 'CLOSED' });
  expect((await insert(db, 'pay_orders', closed)).rows).toHaveLength(1);
  await rejects(update(db, 'pay_orders', closed, { status: 'PENDING' }), '23505');
  const pending = order(p);
  await insert(db, 'pay_orders', pending);
  await update(db, 'pay_orders', pending, { status: 'CLOSED' });
  expect(
    (
      await insert(
        db,
        'pay_orders',
        order(p, {
          biz_type: pending['biz_type'],
          biz_ref: pending['biz_ref'],
          pay_channel: 'alipay',
        }),
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    (await insert(db, 'pay_orders', order(p, { ...key, biz_type: 'other_fixture' }))).rows,
  ).toHaveLength(1);
  expect((await insert(db, 'pay_orders', order(await person(db), key))).rows).toHaveLength(1);
});

it('[AC-B2-15a#8] 并发创建同业务对象只有一条成功，由 PG 唯一约束裁决', async () => {
  const db = h.db();
  await ready(db);
  const p = await person(db);
  const first = order(p);
  const second = order(p, {
    biz_type: first['biz_type'],
    biz_ref: first['biz_ref'],
    pay_channel: 'alipay',
  });
  const results = await Promise.allSettled([
    insert(db, 'pay_orders', first),
    insert(db, 'pay_orders', second),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const failures = results.filter((r) => r.status === 'rejected');
  expect(failures).toHaveLength(1);
  expect(failures[0]?.reason).toMatchObject({ code: '23505' });
});

it('[AC-B2-15a#9] 通知和异常按 app、渠道、渠道标识去重，渠道或 app 不同可以并存', async () => {
  const db = h.db();
  await ready(db);
  const { o, p } = await scenario(db);
  for (const [table, row] of [
    ['pay_notifications', notification(o)],
    ['pay_anomalies', anomaly(p.app_id)],
  ] as const) {
    await insert(db, table, row);
    await rejects(insert(db, table, { ...row, id: randomUUID() }), '23505');
    expect(
      (await insert(db, table, { ...row, id: randomUUID(), pay_channel: 'alipay' })).rows,
    ).toHaveLength(1);
    expect(
      (await insert(db, table, { ...row, id: randomUUID(), app_id: `other-${randomUUID()}` })).rows,
    ).toHaveLength(1);
  }
});

it('[AC-B2-15a#10] 退款商户单号与幂等键各自唯一，业务开通记录按 app 与业务对象唯一', async () => {
  const db = h.db();
  await ready(db);
  const { o, r } = await scenario(db);
  for (const key of ['out_refund_no', 'idempotency_key']) {
    await rejects(insert(db, 'pay_refunds', refund(o, { [key]: r[key] })), '23505');
  }
  await update(db, 'pay_refunds', r, { status: 'SUCCESS' });
  for (const key of ['out_refund_no', 'idempotency_key']) {
    await rejects(insert(db, 'pay_refunds', refund(o, { [key]: r[key] })), '23505');
  }
  const other = await scenario(db);
  expect(
    (
      await insert(
        db,
        'pay_refunds',
        refund(other.o, {
          out_refund_no: r['out_refund_no'],
          idempotency_key: r['idempotency_key'],
        }),
      )
    ).rows,
  ).toHaveLength(1);
  const f = fulfillment(o);
  await insert(db, 'pay_fulfillments', f);
  await rejects(insert(db, 'pay_fulfillments', { ...f, id: randomUUID() }), '23505');
  expect(
    (
      await insert(
        db,
        'pay_fulfillments',
        fulfillment(other.o, { biz_type: f['biz_type'], biz_ref: f['biz_ref'] }),
      )
    ).rows,
  ).toHaveLength(1);
  expect(
    (await insert(db, 'pay_fulfillments', fulfillment(o, { biz_type: 'other_fixture' }))).rows,
  ).toHaveLength(1);
});
