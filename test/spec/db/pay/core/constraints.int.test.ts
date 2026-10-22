import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { expect, it } from 'vitest';

import {
  anomaly,
  attempt,
  fulfillment,
  harness,
  insert,
  notification,
  order,
  ready,
  refund,
  rejects,
  scenario,
  type Row,
  type Table,
} from './kit.ts';

const h = harness(createTestDatabase);

it('[AC-B2-15a#1] 金额为正整数分，退款累计支持零、部分与全额但不能越界，bigint 不丢精度', async () => {
  const db = h.db();
  await ready(db);
  const { p, o } = await scenario(db);
  const factories: [Table, (changes: Row) => Row][] = [
    ['pay_orders', (c) => order(p, c)],
    ['pay_anomalies', (c) => anomaly(p.app_id, c)],
    ['pay_refunds', (c) => refund(o, c)],
  ];
  for (const [table, make] of factories) {
    for (const amount_fen of [0n, -1n])
      await rejects(insert(db, table, make({ amount_fen })), '23514');
    await rejects(insert(db, table, make({ amount_fen: null })), '23502');
    await rejects(insert(db, table, make({ amount_fen: '1.5' })), '22P02');
    for (const amount_fen of [1n, 9007199254740993n]) {
      expect((await insert(db, table, make({ amount_fen }))).rows[0]).toMatchObject({ amount_fen });
    }
    if (table === 'pay_refunds') continue;
    for (const refunded_fen of [-1n, 101n])
      await rejects(insert(db, table, make({ refunded_fen })), '23514');
    await rejects(insert(db, table, make({ refunded_fen: null })), '23502');
    for (const refunded_fen of [0n, 1n, 99n, 100n]) {
      expect((await insert(db, table, make({ refunded_fen }))).rows[0]).toMatchObject({
        refunded_fen,
      });
    }
    expect((await insert(db, table, make({}))).rows[0]).toMatchObject({ refunded_fen: 0n });
  }
});

it('[AC-B2-15a#2] 商户支付与退款单号只接受一至三十二位 ASCII 字母数字', async () => {
  const db = h.db();
  await ready(db);
  const { p, o } = await scenario(db);
  for (const [table, column, make] of [
    ['pay_orders', 'out_trade_no', (c: Row) => order(p, c)],
    ['pay_refunds', 'out_refund_no', (c: Row) => refund(o, c)],
  ] as const) {
    for (const value of [
      '',
      'a'.repeat(33),
      '订单123',
      'Ａ123',
      'a-b',
      'a_b',
      ' a',
      'a ',
      'a\nb',
      'a\n',
      'a\r',
      'a!',
    ]) {
      await rejects(insert(db, table, make({ [column]: value })), '23514');
    }
    await rejects(insert(db, table, make({ [column]: null })), '23502');
    for (const value of ['A', '0', 'Ab09', 'Aa09'.repeat(8)]) {
      expect((await insert(db, table, make({ [column]: value }))).rows[0]).toMatchObject({
        [column]: value,
      });
    }
  }
});

it('[AC-B2-15a#3] 支付、退款、通知、查询与异常的枚举接受全部规定值并拒绝非法值和 NULL', async () => {
  const db = h.db();
  await ready(db);
  const { p, o, a, r } = await scenario(db);
  // 当前 checkout 尚无 contracts/enums/pay.yaml；取值使用任务补充及固定版本 04 §2.4。
  const cases: [Table, string, string[], (c: Row) => Row][] = [
    ['pay_orders', 'pay_channel', ['wechat_pay', 'alipay'], (c) => order(p, c)],
    ['pay_orders', 'status', ['PENDING', 'PAID', 'CLOSED'], (c) => order(p, c)],
    ['pay_notifications', 'pay_channel', ['wechat_pay', 'alipay'], (c) => notification(o, c)],
    ['pay_notifications', 'verify_result', ['ok', 'failed'], (c) => notification(o, c)],
    [
      'pay_query_attempts',
      'kind',
      ['query', 'close', 'refund', 'refund_query'],
      (c) => attempt(o, c),
    ],
    ['pay_anomalies', 'pay_channel', ['wechat_pay', 'alipay'], (c) => anomaly(p.app_id, c)],
    ['pay_anomalies', 'status', ['open', 'refunded', 'closed'], (c) => anomaly(p.app_id, c)],
    [
      'pay_refunds',
      'target_type',
      ['pay_order', 'pay_anomaly'],
      (c) => refund(o, { ...c, target_id: c['target_type'] === 'pay_anomaly' ? a['id'] : o['id'] }),
    ],
    ['pay_refunds', 'status', ['PROCESSING', 'SUCCESS', 'FAILED'], (c) => refund(o, c)],
    [
      'pay_refunds',
      'reason_code',
      ['USER_REQUEST', 'DUPLICATE_PAYMENT', 'ANOMALY_RECEIPT', 'RECON_DIFF', 'OTHER'],
      (c) => refund(o, c),
    ],
    [
      'pay_fulfillments',
      'state',
      ['none', 'active', 'revoked'],
      (c) => fulfillment(o, { biz_ref: randomUUID(), ...c }),
    ],
  ];
  for (const [table, column, valid, make] of cases) {
    for (const value of ['', 'unsupported', `${valid[0]} `])
      await rejects(insert(db, table, make({ [column]: value })), '23514');
    await rejects(insert(db, table, make({ [column]: null })), '23502');
    for (const value of valid)
      expect((await insert(db, table, make({ [column]: value }))).rows[0]).toMatchObject({
        [column]: value,
      });
  }
  expect(
    (
      await insert(
        db,
        'pay_query_attempts',
        attempt(o, { pay_order_id: null, pay_refund_id: r['id'], kind: 'refund_query' }),
      )
    ).rows[0],
  ).toMatchObject({ pay_refund_id: r['id'] });
});

it('[AC-B2-15a#4] 通知至少关联一个商户单号，查询记录恰好关联支付单或退款单之一', async () => {
  const db = h.db();
  await ready(db);
  const { o, r } = await scenario(db);
  await rejects(
    insert(db, 'pay_notifications', notification(o, { out_trade_no: null, out_refund_no: null })),
    '23514',
  );
  for (const change of [
    { out_trade_no: o['out_trade_no'], out_refund_no: null },
    { out_trade_no: null, out_refund_no: r['out_refund_no'] },
    { out_trade_no: o['out_trade_no'], out_refund_no: r['out_refund_no'] },
  ]) {
    expect((await insert(db, 'pay_notifications', notification(o, change))).rows).toHaveLength(1);
  }
  for (const change of [
    { pay_order_id: null, pay_refund_id: null },
    { pay_order_id: o['id'], pay_refund_id: r['id'] },
  ]) {
    await rejects(insert(db, 'pay_query_attempts', attempt(o, change)), '23514');
  }
  for (const change of [
    { pay_order_id: o['id'], pay_refund_id: null },
    { pay_order_id: null, pay_refund_id: r['id'] },
  ]) {
    expect((await insert(db, 'pay_query_attempts', attempt(o, change))).rows).toHaveLength(1);
  }
});

it('[AC-B2-15a#5] 用户、异常单和查询记录的外键拒绝不存在及其他 app 的对象', async () => {
  const db = h.db();
  await ready(db);
  const left = await scenario(db);
  const right = await scenario(db);
  for (const user_id of [randomUUID(), right.p.user_id])
    await rejects(insert(db, 'pay_orders', order(left.p, { user_id })), '23503');
  for (const pay_order_id of [randomUUID(), right.o['id']]) {
    await rejects(insert(db, 'pay_anomalies', anomaly(left.p.app_id, { pay_order_id })), '23503');
    await rejects(insert(db, 'pay_query_attempts', attempt(left.o, { pay_order_id })), '23503');
  }
  for (const pay_refund_id of [randomUUID(), right.r['id']]) {
    await rejects(
      insert(db, 'pay_query_attempts', attempt(left.o, { pay_order_id: null, pay_refund_id })),
      '23503',
    );
  }
  // 渠道有收款但我方无单，异常表必须支持空关联。
  expect(
    (
      await insert(
        db,
        'pay_anomalies',
        anomaly(left.p.app_id, { pay_order_id: null, out_trade_no: null }),
      )
    ).rows,
  ).toHaveLength(1);
});
