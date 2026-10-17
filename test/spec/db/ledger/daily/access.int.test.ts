import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  ROLES,
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

it('[AC-B2-02d#12] couli_app 可插入、读取、更新当日所有金额和计算时刻，其他子户日期不变', async () => {
  await ready(h.app);
  const parent = await account(h.app);
  for (const values of [{}, { sub_account: 'frozen' }, { accounting_date: '2032-06-14' }]) {
    expect(await sqlState(insert(h.app, 'daily_balances', dailyRow(parent, values)))).toBe('ok');
  }
  expect(
    await sqlState(
      sql`UPDATE app.daily_balances SET opening_fen = -1, debit_fen = 100,
      credit_fen = 25, closing_fen = 74, computed_at = TIMESTAMPTZ '2032-06-16 02:00:00+08'
      WHERE app_id = ${parent.app_id} AND account_id = ${parent.id}
        AND sub_account = 'available' AND accounting_date = DATE '2032-06-15'`.execute(h.app),
    ),
  ).toBe('ok');
  const stored = await sql<{
    sub_account: string;
    date: string;
    opening_fen: bigint;
    debit_fen: bigint;
    credit_fen: bigint;
    closing_fen: bigint;
    recomputed: boolean;
  }>`SELECT sub_account, accounting_date::text AS date,
      opening_fen, debit_fen, credit_fen, closing_fen,
      computed_at = TIMESTAMPTZ '2032-06-15 18:00:00+00' AS recomputed
    FROM app.daily_balances WHERE app_id = ${parent.app_id} AND account_id = ${parent.id}
    ORDER BY accounting_date, sub_account`.execute(h.app);
  expect(stored.rows).toEqual([
    {
      sub_account: 'available',
      date: '2032-06-14',
      opening_fen: 0n,
      debit_fen: 0n,
      credit_fen: 0n,
      closing_fen: 0n,
      recomputed: false,
    },
    {
      sub_account: 'available',
      date: '2032-06-15',
      opening_fen: -1n,
      debit_fen: 100n,
      credit_fen: 25n,
      closing_fen: 74n,
      recomputed: true,
    },
    {
      sub_account: 'frozen',
      date: '2032-06-15',
      opening_fen: 0n,
      debit_fen: 0n,
      credit_fen: 0n,
      closing_fen: 0n,
      recomputed: false,
    },
  ]);
});

it('[AC-B2-02d#13] couli_app 可以用主键冲突更新重跑快照，始终保留一行', async () => {
  await ready(h.app);
  const parent = await account(h.app);
  expect(await sqlState(insert(h.app, 'daily_balances', dailyRow(parent)))).toBe('ok');
  for (const closing of [-1n, 7n, 7n]) {
    expect(
      await sqlState(
        sql`INSERT INTO app.daily_balances
        (app_id, account_id, sub_account, accounting_date,
          opening_fen, debit_fen, credit_fen, closing_fen, computed_at)
        VALUES (${parent.app_id}, ${parent.id}, 'available', DATE '2032-06-15',
          -1, 8, 0, ${closing}, TIMESTAMPTZ '2032-06-16 02:00:00+08')
        ON CONFLICT (app_id, account_id, sub_account, accounting_date) DO UPDATE SET
          opening_fen = EXCLUDED.opening_fen, debit_fen = EXCLUDED.debit_fen,
          credit_fen = EXCLUDED.credit_fen, closing_fen = EXCLUDED.closing_fen,
          computed_at = EXCLUDED.computed_at`.execute(h.app),
      ),
    ).toBe('ok');
    const rows = await sql<{ closing_fen: bigint }>`SELECT closing_fen FROM app.daily_balances
      WHERE account_id = ${parent.id}`.execute(h.app);
    expect(rows.rows).toEqual([{ closing_fen: closing }]);
  }
});

it('[AC-B2-02d#14] couli_app DELETE 被权限拒绝 42501，原行保留', async () => {
  await ready(h.app);
  const parent = await account(h.app);
  expect(await sqlState(insert(h.app, 'daily_balances', dailyRow(parent)))).toBe('ok');
  expect(
    await sqlState(
      sql`DELETE FROM app.daily_balances WHERE account_id = ${parent.id}`.execute(h.app),
    ),
  ).toBe('42501');
  const stored = await sql<{ count: bigint }>`SELECT count(*) AS count
    FROM app.daily_balances WHERE account_id = ${parent.id}`.execute(h.app);
  expect(stored.rows).toEqual([{ count: 1n }]);
});

it('[AC-B2-02d#15] readonly 可读，INSERT、UPDATE、DELETE 均返回 42501', async () => {
  await ready(h.app);
  const parent = await account(h.app);
  expect(await sqlState(insert(h.app, 'daily_balances', dailyRow(parent)))).toBe('ok');
  const readonly = h.roles.couli_readonly;
  const stored = await sql<{ closing_fen: bigint }>`SELECT closing_fen FROM app.daily_balances
    WHERE account_id = ${parent.id}`.execute(readonly);
  expect(stored.rows).toEqual([{ closing_fen: 0n }]);
  expect(
    await sqlState(insert(readonly, 'daily_balances', dailyRow(parent, { sub_account: 'frozen' }))),
  ).toBe('42501');
  expect(
    await sqlState(
      sql`UPDATE app.daily_balances SET closing_fen = 1
      WHERE account_id = ${parent.id}`.execute(readonly),
    ),
  ).toBe('42501');
  expect(
    await sqlState(
      sql`DELETE FROM app.daily_balances WHERE account_id = ${parent.id}`.execute(readonly),
    ),
  ).toBe('42501');
});

it('[AC-B2-02d#16] payout 与 maint 不能读取或写入日余额，均返回 42501', async () => {
  await ready(h.app);
  const parent = await account(h.app);
  expect(await sqlState(insert(h.app, 'daily_balances', dailyRow(parent)))).toBe('ok');
  for (const role of ['couli_payout', 'couli_maint'] as const) {
    const db = h.roles[role];
    expect(
      await sqlState(
        sql`SELECT * FROM app.daily_balances WHERE account_id = ${parent.id}`.execute(db),
      ),
      role,
    ).toBe('42501');
    expect(
      await sqlState(insert(db, 'daily_balances', dailyRow(parent, { sub_account: 'frozen' }))),
      role,
    ).toBe('42501');
    expect(
      await sqlState(
        sql`UPDATE app.daily_balances SET closing_fen = 1
        WHERE account_id = ${parent.id}`.execute(db),
      ),
      role,
    ).toBe('42501');
    expect(
      await sqlState(
        sql`DELETE FROM app.daily_balances WHERE account_id = ${parent.id}`.execute(db),
      ),
      role,
    ).toBe('42501');
  }
});

it('[AC-B2-02d#17] 有效授权严格限定 app 读写更新、readonly 读取，无额外表级或列级权限', async () => {
  await ready(h.app);
  for (const role of ROLES) {
    const allowed =
      role === 'couli_app'
        ? ['SELECT', 'INSERT', 'UPDATE']
        : role === 'couli_readonly'
          ? ['SELECT']
          : [];
    for (const privilege of [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
    ]) {
      const result = await sql<{ granted: boolean }>`SELECT
        has_table_privilege(${role}, 'app.daily_balances', ${privilege}) AS granted`.execute(h.app);
      expect(result.rows, `${role} ${privilege}`).toEqual([
        { granted: allowed.includes(privilege) },
      ]);
      if (['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'].includes(privilege)) {
        const column = await sql<{ granted: boolean }>`SELECT
          has_any_column_privilege(${role}, 'app.daily_balances', ${privilege}) AS granted`.execute(
          h.app,
        );
        expect(column.rows, `${role} column ${privilege}`).toEqual([
          { granted: allowed.includes(privilege) },
        ]);
      }
    }
  }
});
