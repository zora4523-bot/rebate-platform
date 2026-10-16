import { MONTH_PARTITIONED_TABLES } from '@couli/db';
import { createTestDatabase } from '@couli/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  TIMEOUT,
  close,
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

it('[AC-B2-02c#19] 分录按 booked_at RANGE 分区，主键为 id + booked_at，自增 id 为 bigint', async () => {
  await ready(h.app);
  const partition = await sql<{ key: string }>`SELECT pg_get_partkeydef(oid) AS key
    FROM pg_class WHERE oid = to_regclass('app.ledger_entries')`.execute(h.app);
  expect(partition.rows).toEqual([{ key: 'RANGE (booked_at)' }]);
  const primary = await sql<{ names: string[] }>`SELECT ARRAY(
    SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord
    ) AS names FROM pg_constraint c WHERE c.conrelid = to_regclass('app.ledger_entries') AND c.contype = 'p'`.execute(
    h.app,
  );
  expect(primary.rows).toEqual([{ names: ['id', 'booked_at'] }]);
  const { account, voucher } = await parents(h.app);
  for (const booked_at of ['2034-06-01T00:00:00Z', '2034-06-02T00:00:00Z']) {
    expect(
      await sqlState(insert(h.app, 'ledger_entries', entryRow(account, voucher, { booked_at }))),
    ).toBe('ok');
  }
  const inserted = await sql<{
    id: bigint;
    booked_at: Date;
  }>`SELECT id, booked_at FROM app.ledger_entries
    WHERE voucher_id = ${voucher['id']} ORDER BY booked_at`.execute(h.app);
  expect(inserted.rows).toHaveLength(2);
  const first = inserted.rows[0]!;
  expect(typeof first.id).toBe('bigint');
  expect(inserted.rows[1]!.id).toBeGreaterThan(first.id);
  // Use OVERRIDING SYSTEM VALUE so both identity variants remain valid designs.
  const repeat = (at: Date) =>
    sql`INSERT INTO app.ledger_entries
    (id, booked_at, app_id, voucher_id, account_id, sub_account, amount_fen, ledger_type,
      sub_type, income_type, balance_after_fen, account_version) OVERRIDING SYSTEM VALUE
    VALUES (${first.id}, ${at}, ${account['app_id']}, ${voucher['id']}, ${account['id']},
      'available', -1, 'REBATE_CREDIT', NULL, 'SERVICE_FEE', 1, 1)`.execute(h.app);
  expect(await sqlState(repeat(first.booked_at))).toBe('23505');
  expect(await sqlState(repeat(new Date('2034-07-01T00:00:00Z')))).toBe('ok');
});

it(
  '[AC-B2-02c#20] 迁移只建 DEFAULT，维护函数白名单与 TS 同步且建月分区幂等',
  async () => {
    await ready(h.app);
    expect([...MONTH_PARTITIONED_TABLES]).toContain('ledger_entries');
    const initial = await sql<{ bound: string }>`SELECT pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = to_regclass('app.ledger_entries')`.execute(h.app);
    expect(initial.rows).toEqual([{ bound: 'DEFAULT' }]);
    const names = await h.roles.couli_maint.transaction().execute(async (trx) => {
      await sql`SET LOCAL TIME ZONE 'Asia/Shanghai'`.execute(trx);
      const result: string[] = [];
      for (const day of ['2031-03-01', '2031-03-31']) {
        const ensured = await sql<{
          name: string;
        }>`SELECT app.ensure_month_partition('ledger_entries', ${day}::date) AS name`.execute(trx);
        result.push(ensured.rows[0]?.name ?? '');
      }
      return result;
    });
    expect(names).toEqual(['ledger_entries_p203103', 'ledger_entries_p203103']);
    const bound = await h.app.transaction().execute(async (trx) => {
      await sql`SET LOCAL TIME ZONE 'UTC'`.execute(trx);
      return sql<{ bound: string }>`SELECT pg_get_expr(relpartbound, oid) AS bound
      FROM pg_class WHERE oid = to_regclass('app.ledger_entries_p203103')`.execute(trx);
    });
    expect(bound.rows).toEqual([
      { bound: "FOR VALUES FROM ('2031-03-01 00:00:00+00') TO ('2031-04-01 00:00:00+00')" },
    ]);
    const { account, voucher } = await parents(h.app);
    const fallback = await sql<{ name: string }>`SELECT c.oid::regclass::text AS name
    FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = to_regclass('app.ledger_entries') AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'`.execute(
      h.app,
    );
    expect(fallback.rows).toHaveLength(1);
    for (const [booked_at, destination] of [
      ['2031-02-28T23:59:59.999Z', fallback.rows[0]!.name],
      ['2031-03-01T00:00:00Z', 'app.ledger_entries_p203103'],
      ['2031-04-01T07:59:59.999+08:00', 'app.ledger_entries_p203103'],
      ['2031-04-01T08:00:00+08:00', fallback.rows[0]!.name],
    ]) {
      // Voucher accounting_date is June: only the supplied booked_at chooses the partition.
      expect(
        await sqlState(insert(h.app, 'ledger_entries', entryRow(account, voucher, { booked_at }))),
      ).toBe('ok');
      const stored = await sql<{
        destination: string;
      }>`SELECT tableoid::regclass::text AS destination
      FROM app.ledger_entries WHERE voucher_id = ${voucher['id']} AND booked_at = ${booked_at}::timestamptz`.execute(
        h.app,
      );
      expect(stored.rows).toEqual([{ destination }]);
    }
    // Parent append-only guards must also protect direct writes on both kinds of child.
    for (const table of [fallback.rows[0]!.name, 'app.ledger_entries_p203103']) {
      const guards = await sql<{ update_guard: boolean; delete_guard: boolean }>`SELECT
      bool_or((tgtype::integer & 16) <> 0) AS update_guard,
      bool_or((tgtype::integer & 8) <> 0) AS delete_guard FROM pg_trigger
      WHERE tgrelid = to_regclass(${table}) AND NOT tgisinternal AND tgenabled IN ('O', 'A')
        AND (tgtype::integer & 1) <> 0 AND (tgtype::integer & 2) <> 0 AND tgqual IS NULL`.execute(
        h.app,
      );
      expect(guards.rows).toEqual([{ update_guard: true, delete_guard: true }]);
      for (const role of ['couli_app', 'couli_readonly', 'couli_payout', 'couli_maint']) {
        const writable = await sql<{
          allowed: boolean;
        }>`SELECT has_any_column_privilege(${role}, ${table}, 'UPDATE')
        OR has_table_privilege(${role}, ${table}, 'DELETE,TRUNCATE') AS allowed`.execute(h.app);
        expect(writable.rows).toEqual([{ allowed: false }]);
      }
    }
  },
  TIMEOUT,
);

it('[AC-B2-02c#21] app 不得执行分区维护，DEFAULT 已有行时不得创建重叠月分区', async () => {
  await ready(h.app);
  expect(
    await sqlState(
      sql`SELECT app.ensure_month_partition('ledger_entries', '2035-01-01'::date)`.execute(h.app),
    ),
  ).toBe('42501');
  const { account, voucher } = await parents(h.app);
  expect(
    await sqlState(
      insert(
        h.app,
        'ledger_entries',
        entryRow(account, voucher, { booked_at: '2035-01-15T00:00:00Z' }),
      ),
    ),
  ).toBe('ok');
  expect(
    await sqlState(
      sql`SELECT app.ensure_month_partition('ledger_entries', '2035-01-01'::date)`.execute(
        h.roles.couli_maint,
      ),
    ),
  ).toBe('23514');
});
