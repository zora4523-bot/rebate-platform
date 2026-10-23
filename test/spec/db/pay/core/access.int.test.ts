import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import {
  AT,
  LATER,
  ROLES,
  TABLES,
  attempt,
  columns,
  fulfillment,
  harness,
  insert,
  notification,
  ready,
  rejects,
  scenario,
  update,
  type Row,
  type Table,
} from './kit.ts';

const h = harness(createTestDatabase);
const MUTABLE: Record<Table, string[]> = {
  pay_orders: [
    'refunded_fen',
    'status',
    'channel_trade_no',
    'launch_issued_at',
    'closing',
    'needs_manual',
    'paid_at',
    'closed_at',
    'close_reason',
    'updated_at',
  ],
  pay_notifications: [],
  pay_query_attempts: [],
  pay_refunds: ['status', 'channel_refund_no', 'succeeded_at', 'failed_at'],
  pay_anomalies: ['refunded_fen', 'status'],
  pay_fulfillments: ['state', 'last_pay_order_id', 'refunded_fen', 'version', 'applied_at'],
};

it('[AC-B2-15a#15] app 只有读、插入和可变列 UPDATE，readonly 只读，payout 与 maint 无收款表权限', async () => {
  const db = h.db();
  await ready(db);
  for (const role of ROLES) {
    for (const table of TABLES) {
      for (const privilege of [
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER',
      ]) {
        const allowed =
          privilege === 'SELECT'
            ? ['couli_app', 'couli_readonly'].includes(role)
            : privilege === 'INSERT' && role === 'couli_app';
        const result =
          await sql`SELECT has_table_privilege(${role}, ${`app.${table}`}, ${privilege}) AS allowed`.execute(
            db,
          );
        expect(result.rows, `${role}.${table}.${privilege}`).toEqual([{ allowed }]);
      }
      for (const column of await columns(db, table)) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
          const allowed =
            privilege === 'SELECT'
              ? ['couli_app', 'couli_readonly'].includes(role)
              : role === 'couli_app' &&
                (privilege === 'INSERT' ||
                  (privilege === 'UPDATE' && MUTABLE[table].includes(column.name)));
          const result =
            await sql`SELECT has_column_privilege(${role}, ${`app.${table}`}, ${column.name}, ${privilege}) AS allowed`.execute(
              db,
            );
          expect(result.rows, `${role}.${table}.${column.name}.${privilege}`).toEqual([
            { allowed },
          ]);
        }
      }
    }
  }
}, 60_000);

it('[AC-B2-15a#16] app 实际可插入六表并更新结果列，退款累计更新不改变支付状态', async () => {
  const db = h.db();
  await ready(db);
  const { o, a, r } = await scenario(db);
  const n = notification(o);
  const q = attempt(o);
  const f = fulfillment(o);
  expect((await insert(db, 'pay_notifications', n)).rows[0]).toMatchObject({
    payload_cipher: n['payload_cipher'],
  });
  expect((await insert(db, 'pay_query_attempts', q)).rows[0]).toMatchObject({
    request: q['request'],
    response: q['response'],
  });
  expect((await insert(db, 'pay_fulfillments', f)).rows[0]).toMatchObject({
    refunded_fen: 0n,
    version: 0n,
  });
  const initial =
    await sql`SELECT closing, needs_manual, refunded_fen FROM app.pay_orders WHERE id = ${o['id']}`.execute(
      db,
    );
  expect(initial.rows).toEqual([{ closing: false, needs_manual: false, refunded_fen: 0n }]);
  const changes: [Table, Row, Row][] = [
    [
      'pay_orders',
      o,
      {
        status: 'PAID',
        channel_trade_no: 'fixture-paid',
        launch_issued_at: AT,
        paid_at: LATER,
        closing: false,
        needs_manual: false,
        updated_at: LATER,
      },
    ],
    [
      'pay_refunds',
      r,
      { status: 'SUCCESS', channel_refund_no: 'fixture-refund', succeeded_at: LATER },
    ],
    ['pay_anomalies', a, { refunded_fen: 100n, status: 'refunded' }],
    [
      'pay_fulfillments',
      f,
      {
        state: 'active',
        last_pay_order_id: o['id'],
        refunded_fen: 0n,
        version: 1n,
        applied_at: LATER,
      },
    ],
  ];
  for (const [table, row, change] of changes) {
    expect((await update(db, table, row, change)).rows[0], table).toMatchObject(change);
  }
  for (const refunded_fen of [1n, 100n]) {
    expect((await update(db, 'pay_orders', o, { refunded_fen })).rows[0]).toMatchObject({
      status: 'PAID',
      refunded_fen,
    });
  }
  await rejects(update(db, 'pay_orders', o, { refunded_fen: 101n }), '23514');
  await rejects(update(db, 'pay_anomalies', a, { refunded_fen: -1n }), '23514');
});

it('[AC-B2-15a#17] app 不可更改单号、金额、业务归属；只插入表不可 UPDATE 或 DELETE', async () => {
  const db = h.db();
  await ready(db);
  const { o, r } = await scenario(db);
  const immutable: [Table, Row, Row][] = [
    [
      'pay_orders',
      o,
      {
        out_trade_no: 'Changed123',
        amount_fen: 101n,
        pay_channel: 'alipay',
        biz_type: 'other',
        biz_ref: 'other',
        user_id: randomUUID(),
      },
    ],
    [
      'pay_refunds',
      r,
      {
        out_refund_no: 'Changed123',
        amount_fen: 11n,
        target_type: 'pay_anomaly',
        target_id: randomUUID(),
      },
    ],
  ];
  for (const [table, row, changes] of immutable) {
    const before =
      await sql`SELECT * FROM ${sql.table(`app.${table}`)} WHERE id = ${row['id']}`.execute(db);
    for (const [key, value] of Object.entries(changes))
      await rejects(update(db, table, row, { [key]: value }), '42501');
    const after =
      await sql`SELECT * FROM ${sql.table(`app.${table}`)} WHERE id = ${row['id']}`.execute(db);
    expect(after.rows).toEqual(before.rows);
  }
  for (const [table, row, change] of [
    ['pay_notifications', notification(o), { handle_result: 'changed' }],
    ['pay_query_attempts', attempt(o), { result: 'changed' }],
  ] as const) {
    const before = await insert(db, table, row);
    await rejects(update(db, table, row, change), '42501');
    await rejects(
      sql`DELETE FROM ${sql.table(`app.${table}`)} WHERE id = ${row['id']}`.execute(db),
      '42501',
    );
    const after =
      await sql`SELECT * FROM ${sql.table(`app.${table}`)} WHERE id = ${row['id']}`.execute(db);
    expect(after.rows).toEqual(before.rows);
  }
});

it('[AC-B2-15a#18] 使用真实业务角色连接：readonly 读得到但不能写，payout 和 maint 连读取都被拒绝', async () => {
  const db = h.db();
  await ready(db);
  const { o, r, a } = await scenario(db);
  const n = notification(o),
    q = attempt(o),
    f = fulfillment(o);
  await insert(db, 'pay_notifications', n);
  await insert(db, 'pay_query_attempts', q);
  await insert(db, 'pay_fulfillments', f);
  const rows: Record<Table, Row> = {
    pay_orders: o,
    pay_refunds: r,
    pay_anomalies: a,
    pay_notifications: n,
    pay_query_attempts: q,
    pay_fulfillments: f,
  };
  for (const role of ['couli_readonly', 'couli_payout', 'couli_maint'] as const) {
    const connection = h.db(role);
    expect(
      (
        await sql`SELECT current_user, current_setting('is_superuser') AS superuser`.execute(
          connection,
        )
      ).rows,
    ).toEqual([{ current_user: role, superuser: 'off' }]);
    for (const table of TABLES) {
      const row = rows[table];
      const read = sql`SELECT * FROM ${sql.table(`app.${table}`)} WHERE id = ${row['id']}`.execute(
        connection,
      );
      if (role === 'couli_readonly') expect((await read).rows).toHaveLength(1);
      else await rejects(read, '42501');
      await rejects(insert(connection, table, { ...row, id: randomUUID() }), '42501');
      await rejects(update(connection, table, row, { app_id: row['app_id'] }), '42501');
      await rejects(
        sql`DELETE FROM ${sql.table(`app.${table}`)} WHERE id = ${row['id']}`.execute(connection),
        '42501',
      );
    }
  }
});
