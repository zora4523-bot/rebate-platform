import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  TIMEOUT,
  account,
  close,
  dailyRow,
  insert,
  open,
  ready,
  sqlState,
  type Harness,
} from './kit.ts';

let h: Harness;
beforeAll(async () => {
  h = await open(createTestDatabase);
}, TIMEOUT);
afterAll(async () => {
  await close(h);
}, TIMEOUT);

it('[AC-B2-02d#1] 日余额各维度必填，金额为 bigint、日期和计算时刻类型正确', async () => {
  await ready(h.app);
  const columns = await sql<{ name: string; type: string; nullable: string }>`
    SELECT column_name AS name, udt_name AS type, is_nullable AS nullable
    FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'daily_balances'
  `.execute(h.app);
  for (const [name, type] of Object.entries({
    app_id: 'text',
    account_id: 'uuid',
    sub_account: 'text',
    accounting_date: 'date',
    opening_fen: 'int8',
    debit_fen: 'int8',
    credit_fen: 'int8',
    closing_fen: 'int8',
    computed_at: 'timestamptz',
  })) {
    expect(columns.rows, name).toContainEqual({ name, type, nullable: 'NO' });
  }
  const row = dailyRow(await account(h.app));
  for (const field of Object.keys(row)) {
    expect(await sqlState(insert(h.app, 'daily_balances', { ...row, [field]: null })), field).toBe(
      '23502',
    );
  }
});

it('[AC-B2-02d#2] 主键精确包含 app、账户、子户和会计日，重复写入被拒', async () => {
  await ready(h.app);
  const key = await sql<{ fields: string[] }>`
    SELECT ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS fields
    FROM pg_constraint c WHERE c.conrelid = 'app.daily_balances'::regclass AND c.contype = 'p'
  `.execute(h.app);
  expect(key.rows).toEqual([
    { fields: ['app_id', 'account_id', 'sub_account', 'accounting_date'] },
  ]);
  const first = await account(h.app);
  const second = await account(h.app, first.app_id);
  const otherApp = await account(h.app);
  const row = dailyRow(first);
  expect(await sqlState(insert(h.app, 'daily_balances', row))).toBe('ok');
  expect(await sqlState(insert(h.app, 'daily_balances', row))).toBe('23505');
  for (const distinct of [
    dailyRow(first, { sub_account: 'frozen' }),
    dailyRow(first, { accounting_date: '2032-06-16' }),
    dailyRow(second),
    dailyRow(otherApp),
  ]) {
    expect(await sqlState(insert(h.app, 'daily_balances', distinct))).toBe('ok');
  }
});

it('[AC-B2-02d#3] 两个并发写入相同日余额键，仅一个成功', async () => {
  await ready(h.app);
  const row = dailyRow(await account(h.app));
  const results = await Promise.all(
    [0, 1].map(() => sqlState(insert(h.app, 'daily_balances', row))),
  );
  expect(results.sort()).toEqual(['23505', 'ok']);
});

it('[AC-B2-02d#4] 借方与贷方分别拒绝 -1，接受 0 和 1，更新同样受约束', async () => {
  await ready(h.app);
  for (const field of ['debit_fen', 'credit_fen']) {
    const parent = await account(h.app);
    expect(
      await sqlState(insert(h.app, 'daily_balances', dailyRow(parent, { [field]: -1n }))),
      field,
    ).toBe('23514');
    expect(await sqlState(insert(h.app, 'daily_balances', dailyRow(parent)))).toBe('ok');
    for (const value of [1n, 0n]) {
      expect(
        await sqlState(
          sql`UPDATE app.daily_balances SET ${sql.ref(field)} = ${value}
          WHERE account_id = ${parent.id}`.execute(h.app),
        ),
      ).toBe('ok');
    }
    expect(
      await sqlState(
        sql`UPDATE app.daily_balances SET ${sql.ref(field)} = -1
        WHERE account_id = ${parent.id}`.execute(h.app),
      ),
    ).toBe('23514');
    const stored = await sql<{ value: bigint }>`SELECT ${sql.ref(field)} AS value
      FROM app.daily_balances WHERE account_id = ${parent.id}`.execute(h.app);
    expect(stored.rows).toEqual([{ value: 0n }]);
  }
});

it('[AC-B2-02d#5] 两种子户均可保存负期初负期末与超过 2^53 的整数分', async () => {
  await ready(h.app);
  const parent = await account(h.app);
  // Deliberately inconsistent: reconciliation must be able to persist a mismatch.
  const amounts = {
    opening_fen: -9007199254740993n,
    debit_fen: 9007199254740995n,
    credit_fen: 9007199254740997n,
    closing_fen: -9007199254740999n,
  };
  for (const sub_account of ['available', 'frozen']) {
    expect(
      await sqlState(
        insert(h.app, 'daily_balances', dailyRow(parent, { ...amounts, sub_account })),
      ),
    ).toBe('ok');
  }
  const stored = await sql<typeof amounts>`SELECT opening_fen, debit_fen, credit_fen, closing_fen
    FROM app.daily_balances WHERE account_id = ${parent.id}`.execute(h.app);
  expect(stored.rows).toEqual([amounts, amounts]);
});

it('[AC-B2-02d#6] 不用 CHECK 拦截期初与发生额、期末的差异，留给日终不变量检查', async () => {
  await ready(h.app);
  const parent = await account(h.app);
  expect(
    await sqlState(insert(h.app, 'daily_balances', dailyRow(parent, { closing_fen: 1n }))),
  ).toBe('ok');
  expect(
    await sqlState(
      sql`UPDATE app.daily_balances SET opening_fen = -1, closing_fen = 7
      WHERE account_id = ${parent.id}`.execute(h.app),
    ),
  ).toBe('ok');
  const stored = await sql<{ opening_fen: bigint; closing_fen: bigint }>`
    SELECT opening_fen, closing_fen FROM app.daily_balances WHERE account_id = ${parent.id}
  `.execute(h.app);
  expect(stored.rows).toEqual([{ opening_fen: -1n, closing_fen: 7n }]);
});

it('[AC-B2-02d#7] 子户仅接受 available 和 frozen，拒绝越界值', async () => {
  await ready(h.app);
  const parent = await account(h.app);
  for (const sub_account of ['self', 'promo', 'AVAILABLE', 'FROZEN', '', 'other']) {
    expect(
      await sqlState(insert(h.app, 'daily_balances', dailyRow(parent, { sub_account }))),
      sub_account,
    ).toBe('23514');
  }
  for (const sub_account of ['available', 'frozen']) {
    expect(await sqlState(insert(h.app, 'daily_balances', dailyRow(parent, { sub_account })))).toBe(
      'ok',
    );
  }
});

it('[AC-B2-02d#8] 外键拒绝不存在的账户和跨 app 账户', async () => {
  await ready(h.app);
  const parent = await account(h.app);
  const other = await account(h.app);
  for (const account_id of [randomUUID(), other.id]) {
    expect(await sqlState(insert(h.app, 'daily_balances', dailyRow(parent, { account_id })))).toBe(
      '23503',
    );
  }
  expect(await sqlState(insert(h.app, 'daily_balances', dailyRow(parent)))).toBe('ok');
  expect(
    await sqlState(
      sql`UPDATE app.daily_balances SET app_id = ${other.app_id}
      WHERE account_id = ${parent.id}`.execute(h.app),
    ),
  ).toBe('23503');
});

it('[AC-B2-02d#9] 外键按 app_id 和 account_id 对应账本账户，更新删除均不级联', async () => {
  await ready(h.app);
  const foreign = await sql<{
    source: string[];
    target: string[];
    deletion: string;
    updating: string;
    valid: boolean;
  }>`SELECT
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) AS source,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
      JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.ord) AS target,
    c.confdeltype::text AS deletion, c.confupdtype::text AS updating, c.convalidated AS valid
    FROM pg_constraint c WHERE c.conrelid = 'app.daily_balances'::regclass
      AND c.confrelid = 'app.ledger_accounts'::regclass AND c.contype = 'f'
  `.execute(h.app);
  expect(foreign.rows).toHaveLength(1);
  const fk = foreign.rows[0]!;
  expect(fk.source).toEqual(['app_id', 'account_id']);
  expect(fk.target).toEqual(['app_id', 'id']);
  expect(fk.valid).toBe(true);
  expect(['a', 'r']).toContain(fk.deletion);
  expect(['a', 'r']).toContain(fk.updating);
});

it('[AC-B2-02d#10] computed_at 无默认值、不可省略，原样保留显式计算时刻', async () => {
  await ready(h.app);
  const columns = await sql<{ name: string; default_value: string | null }>`
    SELECT column_name AS name, column_default AS default_value FROM information_schema.columns
    WHERE table_schema = 'app' AND table_name = 'daily_balances'
      AND column_name IN ('computed_at', 'accounting_date')
  `.execute(h.app);
  expect(columns.rows).toHaveLength(2);
  for (const column of columns.rows) expect(column.default_value, column.name).toBeNull();
  const parent = await account(h.app);
  for (const field of ['computed_at', 'accounting_date']) {
    const omitted = dailyRow(parent);
    delete omitted[field];
    expect(await sqlState(insert(h.app, 'daily_balances', omitted)), field).toBe('23502');
  }
  expect(await sqlState(insert(h.app, 'daily_balances', dailyRow(parent)))).toBe('ok');
  const stored = await sql<{ date: string; exact_time: boolean }>`
    SELECT accounting_date::text AS date,
      computed_at = TIMESTAMPTZ '2032-06-15 17:00:00+00' AS exact_time
    FROM app.daily_balances WHERE account_id = ${parent.id}
  `.execute(h.app);
  expect(stored.rows).toEqual([{ date: '2032-06-15', exact_time: true }]);
});

it('[AC-B2-02d#11] 0038 迁移以正超时开头，约束与独立索引均显式命名', async () => {
  await ready(h.app);
  const path = new URL('../../../../../db/migrations/0038_daily-balances.sql', import.meta.url);
  expect(existsSync(path), 'reserved migration 0038').toBe(true);
  const raw = readFileSync(path, 'utf8');
  expect(raw.startsWith('-- Up Migration\n')).toBe(true);
  const source = raw.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim();
  const statements = source.split(';');
  for (const [index, setting] of ['lock_timeout', 'statement_timeout'].entries()) {
    expect(statements[index]).toMatch(
      new RegExp(
        `^\\s*SET\\s+LOCAL\\s+${setting}\\s*(?:=|TO)\\s*(?:'[1-9][0-9]*\\s*(?:ms|s|min|h|d)?'|[1-9][0-9]*)\\s*$`,
        'i',
      ),
    );
  }
  const constraints = await sql<{ name: string }>`SELECT conname AS name FROM pg_constraint
    WHERE conrelid = 'app.daily_balances'::regclass AND contype IN ('p', 'u', 'c', 'f')
  `.execute(h.app);
  expect(constraints.rows.length).toBeGreaterThanOrEqual(3);
  for (const { name } of constraints.rows) {
    expect(source, `explicit CONSTRAINT ${name}`).toMatch(
      new RegExp(`\\bCONSTRAINT\\s+"?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s`, 'i'),
    );
  }
  const indexes = await sql<{ name: string; constraint_backed: boolean }>`
    SELECT c.relname AS name,
      EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid
        AND k.contype IN ('p', 'u')) AS constraint_backed
    FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE i.indrelid = 'app.daily_balances'::regclass
  `.execute(h.app);
  expect(indexes.rows.length).toBeGreaterThan(0);
  for (const { name, constraint_backed } of indexes.rows) {
    if (!constraint_backed)
      expect(source, `explicit CREATE INDEX ${name}`).toMatch(
        new RegExp(
          `\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+"?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s`,
          'i',
        ),
      );
  }
});
