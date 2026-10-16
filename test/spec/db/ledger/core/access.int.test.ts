import { existsSync, readFileSync } from 'node:fs';

import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  ROLES,
  TABLES,
  TIMEOUT,
  UPDATE_COLUMNS,
  balanceRow,
  close,
  columns,
  entryRow,
  insert,
  open,
  parents,
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

it('[AC-B2-02c#14] app 可读写入四表，账户凭证分录拒绝 UPDATE / DELETE / TRUNCATE', async () => {
  await ready(h.app);
  const { account, voucher } = await parents(h.app);
  const entry = entryRow(account, voucher);
  expect(await sqlState(insert(h.app, 'ledger_entries', entry))).toBe('ok');
  expect(await sqlState(insert(h.app, 'account_balances', balanceRow(account)))).toBe('ok');
  for (const table of TABLES) {
    const stored = await sql`SELECT * FROM ${sql.table(`app.${table}`)}
      WHERE app_id = ${account['app_id']}`.execute(h.app);
    expect(stored.rows).toHaveLength(1);
    if (table !== 'account_balances') {
      expect(
        await sqlState(
          sql`UPDATE ${sql.table(`app.${table}`)} SET app_id = app_id
        WHERE app_id = ${account['app_id']}`.execute(h.app),
        ),
      ).toBe('42501');
    }
    expect(
      await sqlState(
        sql`DELETE FROM ${sql.table(`app.${table}`)}
      WHERE app_id = ${account['app_id']}`.execute(h.app),
      ),
    ).toBe('42501');
    expect(await sqlState(sql`TRUNCATE ${sql.table(`app.${table}`)}`.execute(h.app))).toBe('42501');
  }
  expect(
    (
      await sql<{ amount_fen: bigint }>`SELECT amount_fen FROM app.ledger_entries
    WHERE voucher_id = ${voucher['id']}`.execute(h.app)
    ).rows,
  ).toEqual([{ amount_fen: -617n }]);
});

it('[AC-B2-02c#15] 余额仅四列可 UPDATE，身份字段不可改，持行锁后可一起更新余额和版本', async () => {
  await ready(h.app);
  const { account } = await parents(h.app);
  expect(await sqlState(insert(h.app, 'account_balances', balanceRow(account)))).toBe('ok');
  const updated = await h.app.transaction().execute(async (trx) => {
    const locked = await sql<{ version: string }>`SELECT version::text AS version
      FROM app.account_balances WHERE account_id = ${account['id']} FOR UPDATE`.execute(trx);
    expect(locked.rows).toEqual([{ version: '0' }]);
    return sql<{
      available_fen: bigint;
      frozen_fen: bigint;
      negative_since: string;
      version: string;
    }>`
      UPDATE app.account_balances SET available_fen = -617, frozen_fen = 50,
        negative_since = '2032-06-15'::date, version = version + 1
      WHERE account_id = ${account['id']}
      RETURNING available_fen, frozen_fen, negative_since::text, version::text`.execute(trx);
  });
  expect(updated.rows).toEqual([
    { available_fen: -617n, frozen_fen: 50n, negative_since: '2032-06-15', version: '1' },
  ]);
  for (const { name } of await columns(h.app, 'account_balances')) {
    if (UPDATE_COLUMNS.includes(name)) continue;
    expect(
      await sqlState(
        sql`UPDATE app.account_balances SET ${sql.ref(name)} = ${sql.ref(name)}
      WHERE account_id = ${account['id']}`.execute(h.app),
      ),
      `app must not update ${name}`,
    ).toBe('42501');
  }
  expect(
    await sqlState(
      sql`UPDATE app.account_balances SET available_fen = 0, frozen_fen = 0,
    negative_since = NULL, version = version + 1 WHERE account_id = ${account['id']}`.execute(
        h.app,
      ),
    ),
  ).toBe('ok');
  expect(
    (
      await sql<{ negative_since: null; version: string }>`SELECT negative_since, version::text
    FROM app.account_balances WHERE account_id = ${account['id']}`.execute(h.app)
    ).rows,
  ).toEqual([{ negative_since: null, version: '2' }]);
});

for (const role of ROLES) {
  it(
    `[AC-B2-02c#16] ${role} 的表级和逐列权限精确符合 D8`,
    async () => {
      await ready(h.app);
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
          const result = await sql<{ allowed: boolean }>`SELECT has_table_privilege(
          ${role}, ${`app.${table}`}, ${privilege}) AS allowed`.execute(h.app);
          const allowed =
            privilege === 'SELECT'
              ? ['couli_app', 'couli_readonly'].includes(role)
              : privilege === 'INSERT' && role === 'couli_app';
          expect(result.rows, `${role}.${table}.${privilege}`).toEqual([{ allowed }]);
        }
        // Table ACL alone misses UPDATE(column) or INSERT(column) grants.
        for (const { name } of await columns(h.app, table)) {
          for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
            const result = await sql<{ allowed: boolean }>`SELECT has_column_privilege(
            ${role}, ${`app.${table}`}, ${name}, ${privilege}) AS allowed`.execute(h.app);
            const allowed =
              privilege === 'SELECT'
                ? ['couli_app', 'couli_readonly'].includes(role)
                : role === 'couli_app' &&
                  (privilege === 'INSERT' ||
                    (privilege === 'UPDATE' &&
                      table === 'account_balances' &&
                      UPDATE_COLUMNS.includes(name)));
            expect(result.rows, `${role}.${table}.${name}.${privilege}`).toEqual([{ allowed }]);
          }
        }
      }
    },
    TIMEOUT,
  );
}

for (const role of ['couli_readonly', 'couli_payout', 'couli_maint'] as const) {
  it(`[AC-B2-02c#17] ${role} 实际写入与变更被拒，只有 readonly 可读`, async () => {
    await ready(h.app);
    const { account, voucher } = await parents(h.app);
    const entry = entryRow(account, voucher);
    const balance = balanceRow(account);
    expect(await sqlState(insert(h.app, 'ledger_entries', entry))).toBe('ok');
    expect(await sqlState(insert(h.app, 'account_balances', balance))).toBe('ok');
    for (const [table, row] of [
      ['ledger_accounts', account],
      ['ledger_vouchers', voucher],
      ['ledger_entries', entry],
      ['account_balances', balance],
    ] as const) {
      const db = h.roles[role];
      const read = sql`SELECT * FROM ${sql.table(`app.${table}`)} WHERE app_id = ${account['app_id']}`;
      if (role === 'couli_readonly') expect((await read.execute(db)).rows).toHaveLength(1);
      else expect(await sqlState(read.execute(db))).toBe('42501');
      expect(await sqlState(insert(db, table, row))).toBe('42501');
      const field = table === 'account_balances' ? 'available_fen' : 'app_id';
      expect(
        await sqlState(
          sql`UPDATE ${sql.table(`app.${table}`)} SET ${sql.ref(field)} = ${sql.ref(field)}
        WHERE app_id = ${account['app_id']}`.execute(db),
        ),
      ).toBe('42501');
      expect(
        await sqlState(
          sql`DELETE FROM ${sql.table(`app.${table}`)}
        WHERE app_id = ${account['app_id']}`.execute(db),
        ),
      ).toBe('42501');
    }
  });
}

// The trusted fixture exposes business roles only. Catalog evidence below is NOT
// a substitute for executing UPDATE/DELETE as a superuser in an isolated database.
// TODO(规划/11 §2.3): 编排者补特权触发器执行验证 — blocked on 测试设施未提供特权执行入口。
it('[AC-B2-02c#18] 凭证与分录挂载具名、无条件的行级禁止改删触发器', async () => {
  await ready(h.app);
  const path = new URL('../../../../../db/migrations/0037_ledger-core.sql', import.meta.url);
  expect(existsSync(path), 'reserved migration 0037').toBe(true);
  const source = readFileSync(path, 'utf8').replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '');
  for (const table of ['ledger_vouchers', 'ledger_entries']) {
    const guards = await sql<{
      name: string;
      body: string;
      events: number;
      qualified: boolean;
      columns: string;
      language: string;
    }>`
      SELECT t.tgname AS name, p.prosrc AS body, t.tgtype::integer AS events,
        t.tgqual IS NOT NULL AS qualified, t.tgattr::text AS columns, l.lanname AS language
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid JOIN pg_language l ON l.oid = p.prolang
      WHERE t.tgrelid = to_regclass(${`app.${table}`}) AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A')
    `.execute(h.app);
    for (const event of [8, 16]) {
      const matched = guards.rows.filter(
        (g) =>
          (g.events & event) !== 0 &&
          (g.events & 1) !== 0 &&
          (g.events & 2) !== 0 &&
          !g.qualified &&
          g.columns === '',
      );
      expect(
        matched.length,
        `${table} BEFORE ROW ${event === 8 ? 'DELETE' : 'UPDATE'}`,
      ).toBeGreaterThan(0);
      expect(
        matched.some(({ body, language }) => {
          const normalized = body.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim();
          // Existing app.reject_update_delete() raises immediately, independently of role.
          return (
            language === 'plpgsql' &&
            /^BEGIN\s+RAISE\s+(?:EXCEPTION\b|SQLSTATE\s+'[A-Z0-9]{5}'|restrict_violation\b)/i.test(
              normalized,
            ) &&
            !/\b(?:IF|RETURN|EXCEPTION\s+WHEN)\b/i.test(normalized)
          );
        }),
        `${table} unconditional rejection, no role bypass`,
      ).toBe(true);
      for (const { name } of matched) {
        expect(source).toMatch(
          new RegExp(`\\bCREATE\\s+(?:OR\\s+REPLACE\\s+)?TRIGGER\\s+"?${name}"?\\s`, 'i'),
        );
      }
    }
  }
});
