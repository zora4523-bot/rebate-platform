import { randomUUID } from 'node:crypto';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  SHAPES,
  TIMEOUT,
  close,
  columns,
  hold,
  insert,
  open,
  person,
  ready,
  sqlState,
  stored,
  withdrawal,
  type Harness,
  type Table,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

for (const table of ['withdrawals', 'withdraw_holds'] as const) {
  it(`[AC-B2-05b#1] ${table} 逐列类型、可空性、默认值与约定一致`, async () => {
    await ready(h.app, table);
    const found = await columns(h.app, table);
    expect(found.map((c) => c.name).sort()).toEqual(Object.keys(SHAPES[table]).sort());
    for (const [name, [type, nullable, default_expr]] of Object.entries(SHAPES[table])) {
      expect(found, name).toContainEqual({ name, type, nullable, default_expr });
    }
  });

  it(`[AC-B2-05b#2] ${table} 每个必填列拒绝显式 NULL，主键全局唯一`, async () => {
    await ready(h.app, table);
    const owner = await person(h.app);
    const row = table === 'withdrawals' ? withdrawal(owner) : hold(owner);
    for (const [name, [, nullable]] of Object.entries(SHAPES[table])) {
      if (!nullable)
        expect(await sqlState(insert(h.app, table, { ...row, [name]: null })), name).toBe('23502');
    }
    expect(await sqlState(insert(h.app, table, row))).toBe('ok');
    const other = await person(h.app);
    const duplicate = table === 'withdrawals' ? withdrawal(other) : hold(other);
    expect(await sqlState(insert(h.app, table, { ...duplicate, id: row['id'] }))).toBe('23505');
  });

  it(`[AC-B2-05b#3] ${table} 约束命名且已验证，用户外键含 app_id 并禁止级联`, async () => {
    await ready(h.app, table);
    const result = await sql<{
      name: string;
      kind: string;
      source: string[];
      target: string | null;
      target_columns: string[];
      deletion: string;
      updating: string;
      valid: boolean;
    }>`SELECT c.conname::text AS name, c.contype::text AS kind,
      ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS source,
      CASE WHEN c.confrelid = 0 THEN NULL ELSE c.confrelid::regclass::text END AS target,
      ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.ord) AS target_columns,
      c.confdeltype::text AS deletion, c.confupdtype::text AS updating, c.convalidated AS valid
      FROM pg_constraint c WHERE c.conrelid = to_regclass(${`app.${table}`})`.execute(h.app);
    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'p', source: ['id'] }),
        expect.objectContaining({ kind: 'c' }),
      ]),
    );
    for (const row of result.rows) {
      expect(row.name).not.toBe('');
      expect(row.valid).toBe(true);
    }
    const fk = result.rows.find((r) => r.kind === 'f' && r.source.join(',') === 'app_id,user_id');
    expect(fk).toMatchObject({ target: 'app.users', target_columns: ['app_id', 'id'] });
    expect(['a', 'r']).toContain(fk?.deletion);
    expect(['a', 'r']).toContain(fk?.updating);
    if (table === 'withdrawals') {
      expect(result.rows).toContainEqual(
        expect.objectContaining({ kind: 'u', source: ['app_id', 'out_biz_no'] }),
      );
    }
    const owner = await person(h.app);
    const foreign = await person(h.app);
    const row = table === 'withdrawals' ? withdrawal(owner) : hold(owner);
    for (const user_id of [randomUUID(), foreign.user_id]) {
      expect(await sqlState(insert(h.app, table, { ...row, user_id }))).toBe('23503');
    }
    await insert(h.app, table, row);
    expect(
      await sqlState(sql`DELETE FROM app.users WHERE id = ${owner.user_id}`.execute(h.app)),
    ).toBe('23503');
    expect(await stored(h.app, table, row['id'])).toHaveLength(1);
  });
}

const INDEXES: { table: Table; name: string; keys: string[]; predicate: string | null }[] = [
  {
    table: 'withdrawals',
    name: 'withdrawals_user_created_idx',
    keys: ['app_id', 'user_id', 'created_at'],
    predicate: null,
  },
  {
    table: 'withdrawals',
    name: 'withdrawals_payee_created_idx',
    keys: ['app_id', 'payee_hmac', 'created_at'],
    predicate: null,
  },
  {
    table: 'withdrawals',
    name: 'withdrawals_open_idx',
    keys: ['app_id', 'user_id'],
    predicate: 'open',
  },
  {
    table: 'withdraw_holds',
    name: 'withdraw_holds_active_idx',
    keys: ['app_id', 'user_id'],
    predicate: 'unreleased',
  },
];
for (const { table, name, keys, predicate } of INDEXES) {
  it(`[AC-B2-05b#4] ${name} 索引列顺序、可用性与筛选条件正确`, async () => {
    await ready(h.app, table);
    const found = await sql<{
      keys: string[];
      valid: boolean;
      ready: boolean;
      unique: boolean;
      method: string;
      predicate: string | null;
    }>`
      SELECT ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num
        WHERE k.ord <= i.indnkeyatts ORDER BY k.ord) AS keys,
        i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS unique,
        am.amname::text AS method, pg_get_expr(i.indpred, i.indrelid) AS predicate
      FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_am am ON am.oid = idx.relam
      WHERE i.indrelid = to_regclass(${`app.${table}`}) AND idx.relname = ${name}`.execute(h.app);
    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]).toMatchObject({
      keys,
      valid: true,
      ready: true,
      unique: false,
      method: 'btree',
    });
    if (predicate === null) expect(found.rows[0]?.predicate).toBeNull();
    else if (predicate === 'unreleased')
      expect(found.rows[0]?.predicate).toMatch(/^\(?released_at IS NULL\)?$/i);
    else {
      const actual = found.rows[0]?.predicate;
      expect(actual).toBeTypeOf('string');
      // Evaluate the catalog predicate over every status rather than relying on SQL formatting.
      const evaluation = await sql
        .raw<{ status: string; included: boolean }>(
          `
        SELECT status, (${actual}) AS included FROM (VALUES
        ('PENDING_REVIEW'), ('APPROVED'), ('PAYING'), ('REJECTED'), ('PAID_API'), ('PAID_MANUAL'), ('FAILED')) s(status)
        ORDER BY status`,
        )
        .execute(h.app);
      expect(evaluation.rows.filter((r) => r.included).map((r) => r.status)).toEqual([
        'APPROVED',
        'PAYING',
        'PENDING_REVIEW',
      ]);
    }
  });
}

it('[AC-B2-05b#5] out_biz_no 安装无条件 BEFORE UPDATE OF 行触发器并复用拒绝函数', async () => {
  await ready(h.app);
  const found = await sql<{
    name: string;
    enabled: string;
    kind: number;
    columns: string[];
    guard: string;
    condition: string | null;
    args: number;
  }>`
    SELECT t.tgname::text AS name, t.tgenabled::text AS enabled, t.tgtype::integer AS kind,
      ARRAY(SELECT a.attname::text FROM unnest(t.tgattr) k(num)
        JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.num) AS columns,
      t.tgfoid::regprocedure::text AS guard, pg_get_expr(t.tgqual, t.tgrelid) AS condition,
      t.tgnargs::integer AS args
    FROM pg_trigger t WHERE t.tgrelid = to_regclass('app.withdrawals') AND NOT t.tgisinternal`.execute(
    h.app,
  );
  expect(found.rows).toContainEqual(
    expect.objectContaining({
      enabled: expect.stringMatching(/^[OA]$/),
      kind: 19,
      columns: ['out_biz_no'],
      guard: 'app.reject_update_delete()',
      condition: null,
      args: 0,
    }),
  );
  // Business roles cannot reach this trigger because column privileges reject first.
  // Catalog binding plus the existing unconditional 23001 function establishes the second barrier.
  const fn = await sql<{ body: string }>`SELECT prosrc AS body FROM pg_proc
    WHERE oid = 'app.reject_update_delete()'::regprocedure`.execute(h.app);
  expect(fn.rows[0]?.body).toMatch(/RAISE EXCEPTION[\s\S]*ERRCODE\s*=\s*'restrict_violation'/i);
  expect(fn.rows[0]?.body).not.toMatch(/\bIF\b|\bRETURN\b/i);
});

it('[AC-B2-05b#6] 省略控制字段采用零和 false 默认值；注入时间原样保存', async () => {
  await ready(h.app);
  await ready(h.app, 'withdraw_holds');
  const owner = await person(h.app);
  const w = withdrawal(owner);
  const holdRow = hold(owner);
  await insert(h.app, 'withdrawals', w);
  await insert(h.app, 'withdraw_holds', holdRow);
  expect(await stored(h.app, 'withdrawals', w['id'])).toEqual([
    expect.objectContaining({
      ...w,
      execute_seq: 0,
      row_version: 0,
      needs_manual: false,
    }),
  ]);
  expect(await stored(h.app, 'withdraw_holds', holdRow['id'])).toEqual([
    expect.objectContaining(holdRow),
  ]);
});
