import { readdirSync, readFileSync } from 'node:fs';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { expect, it } from 'vitest';

import { TABLES, columns, harness, ready, type Table } from './kit.ts';

const h = harness(createTestDatabase);

const REQUIRED: Record<Table, Record<string, string>> = {
  pay_orders: {
    user_id: 'uuid',
    biz_type: 'text',
    biz_ref: 'text',
    pay_channel: 'text',
    amount_fen: 'int8',
    refunded_fen: 'int8',
    status: 'text',
    out_trade_no: 'text',
    channel_trade_no: 'text',
    expire_at: 'timestamptz',
    launch_issued_at: 'timestamptz',
    closing: 'bool',
    needs_manual: 'bool',
    paid_at: 'timestamptz',
    closed_at: 'timestamptz',
    close_reason: 'text',
    updated_at: 'timestamptz',
  },
  pay_notifications: {
    pay_channel: 'text',
    notify_id: 'text',
    out_trade_no: 'text',
    out_refund_no: 'text',
    payload_cipher: 'bytea',
    verify_result: 'text',
    handle_result: 'text',
    received_at: 'timestamptz',
  },
  pay_query_attempts: {
    pay_order_id: 'uuid',
    pay_refund_id: 'uuid',
    kind: 'text',
    request: 'jsonb',
    response: 'jsonb',
    result: 'text',
    at: 'timestamptz',
  },
  pay_refunds: {
    target_type: 'text',
    target_id: 'uuid',
    idempotency_key: 'text',
    out_refund_no: 'text',
    amount_fen: 'int8',
    reason_code: 'text',
    status: 'text',
    channel_refund_no: 'text',
    operator: 'text',
    succeeded_at: 'timestamptz',
    failed_at: 'timestamptz',
  },
  pay_anomalies: {
    pay_channel: 'text',
    channel_trade_no: 'text',
    out_trade_no: 'text',
    pay_order_id: 'uuid',
    amount_fen: 'int8',
    refunded_fen: 'int8',
    evidence: 'jsonb',
    status: 'text',
  },
  pay_fulfillments: {
    biz_type: 'text',
    biz_ref: 'text',
    state: 'text',
    last_pay_order_id: 'uuid',
    refunded_fen: 'int8',
    version: 'int8',
    applied_at: 'timestamptz',
  },
};
const NULLABLE: Record<Table, string[]> = {
  pay_orders: ['channel_trade_no', 'launch_issued_at', 'paid_at', 'closed_at', 'close_reason'],
  pay_notifications: ['out_trade_no', 'out_refund_no', 'handle_result'],
  pay_query_attempts: ['pay_order_id', 'pay_refund_id'],
  pay_refunds: ['channel_refund_no', 'succeeded_at', 'failed_at'],
  pay_anomalies: ['out_trade_no', 'pay_order_id'],
  pay_fulfillments: ['last_pay_order_id', 'applied_at'],
};

it('[AC-B2-15a#11] 六表字段类型、租户与主键非空，业务时间无 SQL 时钟默认值', async () => {
  const db = h.db();
  await ready(db);
  for (const table of TABLES) {
    const stored = await columns(db, table);
    const required = { id: 'uuid', app_id: 'text', created_at: 'timestamptz', ...REQUIRED[table] };
    for (const [name, type] of Object.entries(required)) {
      expect(stored, `${table}.${name}`).toContainEqual(expect.objectContaining({ name, type }));
    }
    // request/response/result 可在未知结果时留空，任务未要求它们的非空策略。
    for (const column of stored) {
      if (!(column.name in required)) continue;
      if (!(
        table === 'pay_query_attempts' && ['request', 'response', 'result'].includes(column.name)
      )) {
        expect(column.nullable, `${table}.${column.name}`).toBe(
          NULLABLE[table].includes(column.name),
        );
      }
      if (
        column.type === 'uuid' ||
        (column.type === 'timestamptz' && column.name !== 'created_at')
      ) {
        expect(column.expression, `${table}.${column.name}`).toBeNull();
      }
      if (column.name === 'created_at')
        expect(column.expression).toMatch(/^(now\(\)|CURRENT_TIMESTAMP)$/i);
    }
    const pk = await sql<{ keys: string[] }>`SELECT ARRAY(
      SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num, pos)
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.num ORDER BY x.pos) AS keys
      FROM pg_constraint k WHERE k.conrelid = to_regclass(${`app.${table}`}) AND k.contype = 'p'`.execute(
      db,
    );
    expect(pk.rows, table).toEqual([{ keys: ['id'] }]);
  }
});

it('[AC-B2-15a#12] 用户列表、过期扫描和两类查询流水具备按 app 开头的有效索引', async () => {
  const db = h.db();
  await ready(db);
  for (const [table, keys] of [
    ['pay_orders', ['app_id', 'user_id', 'created_at']],
    ['pay_orders', ['app_id', 'status', 'expire_at']],
    ['pay_query_attempts', ['app_id', 'pay_order_id', 'at']],
    ['pay_query_attempts', ['app_id', 'pay_refund_id', 'at']],
  ] as const) {
    const indexes = await sql<{ keys: string[]; valid: boolean }>`SELECT
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY x(num, pos)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = x.num
        WHERE x.pos <= i.indnkeyatts ORDER BY x.pos) AS keys,
      i.indisvalid AND i.indisready AS valid FROM pg_index i
      WHERE i.indrelid = to_regclass(${`app.${table}`}) AND i.indpred IS NULL`.execute(db);
    expect(indexes.rows, table).toContainEqual({ keys: [...keys], valid: true });
  }
  for (const table of TABLES) {
    const foreignKeys = await sql<{
      keys: string[];
      on_delete: string;
      on_update: string;
      valid: boolean;
    }>`SELECT
      ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num, pos)
        JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = x.num ORDER BY x.pos) AS keys,
      confdeltype::text AS on_delete, confupdtype::text AS on_update, convalidated AS valid
      FROM pg_constraint k WHERE k.conrelid = to_regclass(${`app.${table}`}) AND k.contype = 'f'`.execute(
      db,
    );
    for (const fk of foreignKeys.rows) {
      expect(fk.keys[0], table).toBe('app_id');
      expect(['a', 'r'], table).toContain(fk.on_delete);
      expect(['a', 'r'], table).toContain(fk.on_update);
      expect(fk.valid, table).toBe(true);
    }
  }
});

it('[AC-B2-15a#13] 同一建表迁移显式命名约束和索引，不用 squawk 忽略且设置正超时', async () => {
  await ready(h.db());
  const directory = new URL('../../../../../db/migrations/', import.meta.url);
  const migrations = readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .map((name) => ({ name, raw: readFileSync(new URL(name, directory), 'utf8') }));
  const matches = migrations.filter(({ raw }) =>
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?app\.pay_orders\s*\(/i.test(raw.replaceAll('"', '')),
  );
  expect(matches).toHaveLength(1);
  const raw = matches[0]!.raw;
  expect(raw).not.toMatch(/squawk-ignore/i);
  const source = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .replaceAll('"', '');
  expect(source).toMatch(/SET\s+LOCAL\s+lock_timeout\s*=\s*'5s'/i);
  expect(source).toMatch(/SET\s+LOCAL\s+statement_timeout\s*=\s*'30s'/i);
  for (const table of TABLES) {
    expect(source, table).toMatch(
      new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?app\\.${table}\\s*\\(`, 'i'),
    );
    expect(source, table).toMatch(
      new RegExp(`GRANT[\\s\\S]*?ON(?:\\s+TABLE)?\\s+app\\.${table}\\s+TO\\s+couli_app`, 'i'),
    );
  }
  // 检查 SQL 原文才能区别显式名字与 PostgreSQL 自动生成名字。
  const unnamed = /\b(?:PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK)\s*\(/gi;
  for (const match of source.matchAll(unnamed)) {
    expect(source.slice(0, match.index), match[0]).toMatch(/\bCONSTRAINT\s+[a-z_][a-z0-9_]*\s*$/i);
  }
  expect(source).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?ON\b/i);
});

it('[AC-B2-15a#14] 不可变列和只插入保护为启用的 BEFORE ROW 触发器，独立于角色授权', async () => {
  const db = h.db();
  await ready(db);
  for (const [table, fields] of [
    ['pay_orders', ['out_trade_no', 'amount_fen', 'pay_channel', 'biz_type', 'biz_ref', 'user_id']],
    ['pay_refunds', ['out_refund_no', 'amount_fen', 'target_type', 'target_id']],
  ] as const) {
    const result = await sql<{
      name: string;
      flags: number;
      enabled: string;
      function_name: string;
      body: string;
    }>`SELECT
      t.tgname AS name, t.tgtype::integer AS flags, t.tgenabled::text AS enabled,
      p.proname AS function_name, p.prosrc AS body
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE t.tgrelid = to_regclass(${`app.${table}`}) AND NOT t.tgisinternal
        AND t.tgname = ${`${table}_immutable_columns`} AND n.nspname = 'app'`.execute(db);
    expect(result.rows).toHaveLength(1);
    const trigger = result.rows[0]!;
    expect(trigger.flags & 19).toBe(19); // ROW | BEFORE | UPDATE
    expect(['O', 'A']).toContain(trigger.enabled);
    if (table === 'pay_orders')
      expect(trigger.function_name).toBe('pay_orders_reject_immutable_update');
    expect(trigger.body).toMatch(/RAISE\s+EXCEPTION/i);
    for (const field of fields) {
      expect(trigger.body).toMatch(new RegExp(`\\bOLD\\.${field}\\b`, 'i'));
      expect(trigger.body).toMatch(new RegExp(`\\bNEW\\.${field}\\b`, 'i'));
    }
  }
  for (const table of ['pay_notifications', 'pay_query_attempts']) {
    const result = await sql<{ flags: number; enabled: string }>`SELECT
      t.tgtype::integer AS flags, t.tgenabled::text AS enabled FROM pg_trigger t
      JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE t.tgrelid = to_regclass(${`app.${table}`}) AND NOT t.tgisinternal
        AND p.proname = 'reject_update_delete' AND n.nspname = 'app'`.execute(db);
    expect(
      result.rows.some((t) => ['O', 'A'].includes(t.enabled) && (t.flags & 19) === 19),
      `${table} UPDATE`,
    ).toBe(true);
    expect(
      result.rows.some((t) => ['O', 'A'].includes(t.enabled) && (t.flags & 11) === 11),
      `${table} DELETE`,
    ).toBe(true);
  }
});
